import {
  companySecrets,
  heartbeatRuns,
  issues,
  companyMemberships,
  connectionGrantDelegations,
  connectionGrants,
  toolConnectionInstalls,
  toolConnections,
  userSecretDefinitions,
  type Db,
} from "@paperclipai/db";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { isGitHubDotCom } from "./github-fetch.js";
import { secretService } from "./secrets.js";
import { toolAccessService } from "./tool-access.js";
import { loadGitHubTokenRepositories } from "./tool-access/github-access-discovery.js";
import {
  configuredGitHubOwners,
  githubOwnerFromRemoteUrl,
  grantGitHubOwners,
  normalizeGitHubOwner,
  routeGitHubCandidatesByOwner,
} from "./tool-access/github-owner-routing.js";

/**
 * Server-side git credentials for managed project checkouts and execution-workspace base
 * refreshes. Operators store a GitHub token as a company secret under one of the well-known
 * names below (the same convention the GitHub external-object provider reads); this module
 * resolves it and turns it into a git invocation that authenticates clone/fetch against
 * github.com over HTTPS without ever placing the token in argv, URLs, or on disk.
 *
 * The provider factory is deliberately the single seam for future credential sources (for
 * example a brokered GitHub connection): swap the factory, keep every call site unchanged.
 */

/** Company-secret names probed for a GitHub token, in priority order. */
export const DEFAULT_GITHUB_TOKEN_SECRET_NAMES = ["GITHUB_TOKEN", "GH_TOKEN", "PAPERCLIP_GITHUB_TOKEN"] as const;

/** Env var the credential helper reads the token from; never appears in argv. */
export const GIT_CREDENTIAL_TOKEN_ENV_KEY = "PAPERCLIP_GIT_TOKEN";

// `!`-prefixed helpers run via `sh -c` with the credential action appended as "$1". Only the
// `get` action answers; store/erase drain stdin and exit 0 silently. `x-access-token`
// authenticates classic PATs, fine-grained PATs, and GitHub App installation tokens alike.
//
// The helper re-validates the credential request from its stdin description and answers only
// for `protocol=https` + `host=github.com`/`www.github.com`. The pre-invocation URL check
// runs before git applies configuration like repository-local `url.<base>.insteadOf`
// rewrites, so a rewritten remote could otherwise request the token for an arbitrary host.
// The helper is additionally installed URL-scoped (`credential.https://github.com.helper`)
// so git does not consult it for other hosts in the first place — two independent gates.
const GIT_CREDENTIAL_HELPER =
  `!f() { ok=; proto=; while IFS= read -r l && [ -n "$l" ]; do case "$l" in host=github.com|host=www.github.com) ok=1;; protocol=https) proto=1;; esac; done; if [ "$1" = get ] && [ -n "$ok" ] && [ -n "$proto" ]; then printf 'username=x-access-token\\npassword=%s\\n' "$PAPERCLIP_GIT_TOKEN"; fi; }; f`;

export type GitCredential = {
  token: string;
  source: "managed_connection" | "company_secret" | "server_env";
  /** The company-secret name the token came from; null for a server-environment token. */
  secretName: string | null;
  githubIdentity?: { userId: string; login: string };
  identitySource?: "personal" | "dedicated";
  connectionId?: string;
  grantId?: string;
};

/** A prepared, credential-bearing git invocation: config args plus the env that carries the token. */
export type GitAuthInvocation = {
  configArgs: string[];
  env: Record<string, string>;
  source: GitCredential["source"];
  secretName: string | null;
};

/**
 * Resolve auth for one remote URL. Returns null when the URL is out of scope (non-GitHub,
 * ssh, or already credentialed) or when no token is available — callers then run git with
 * ambient behavior, exactly as before this module existed.
 */
export type GitRemoteAuthProvider = (remoteUrl: string) => Promise<GitAuthInvocation | null>;

/**
 * True only for `https://github.com/...` (or `www.`) URLs without inline userinfo. GHES and
 * other hosts are out of scope for now — sending a github.com token to an arbitrary host
 * would leak it, and an operator's inline URL credential must never be overridden.
 */
export function isGitHubHttpsRemoteUrl(remoteUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(remoteUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;
  return isGitHubDotCom(parsed.hostname);
}

function isSupportedGitHubRemoteUrl(remoteUrl: string): boolean {
  if (isGitHubHttpsRemoteUrl(remoteUrl)) return true;
  if (/^git@(?:www\.)?github\.com:[^\s]+$/i.test(remoteUrl)) return true;
  try {
    const parsed = new URL(remoteUrl);
    return parsed.protocol === "ssh:" && parsed.username === "git" && !parsed.password && isGitHubDotCom(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Mask credential material embedded in URLs so it never reaches warnings, run errors, or
 * persisted payloads: userinfo on any scheme (`https://user:token@host`,
 * `ssh://user:pass@host`) and the entire query string of any URL (`?access_token=…` and
 * every other parameter — masked wholesale rather than by an inevitably incomplete
 * parameter-name list). Scp-style remotes (`git@host:path`) carry no password and are left
 * alone.
 */
export function scrubGitCredentialText(text: string): string {
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, "$1***@")
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s"'?]*)\?[^\s"']*/gi, "$1?***");
}

export function buildGitAuthInvocation(credential: GitCredential): GitAuthInvocation {
  // Credentials only. No commit identity is imposed here: command-line config
  // and GIT_AUTHOR_* would outrank the repository's own user.name/user.email
  // and the operator's per-project identities. Commits made through Paperclip
  // take their identity from the launcher's scratch Git configuration (see
  // @paperclipai/adapter-utils/git-commit-identity).
  const configEntries = [
    ["credential.helper", ""],
    ["credential.https://github.com.helper", GIT_CREDENTIAL_HELPER],
    ["credential.https://www.github.com.helper", GIT_CREDENTIAL_HELPER],
    ["url.https://github.com/.insteadOf", "git@github.com:"],
    ["url.https://github.com/.insteadOf", "ssh://git@github.com/"],
    ["url.https://github.com/.insteadOf", "git@www.github.com:"],
    ["url.https://github.com/.insteadOf", "ssh://git@www.github.com/"],
  ];
  return {
    // The leading empty helper clears ambient helpers (gh, osxkeychain, credential-store) so
    // they neither outrank the resolved token nor receive store/erase callbacks for it. The
    // token helper is installed URL-scoped: git consults it only for credential requests
    // whose context matches github.com over https, so an `insteadOf`-rewritten remote never
    // reaches it (and the helper itself re-checks the request host — see above).
    configArgs: [
      "-c", "credential.helper=",
      "-c", `credential.https://github.com.helper=${GIT_CREDENTIAL_HELPER}`,
      "-c", `credential.https://www.github.com.helper=${GIT_CREDENTIAL_HELPER}`,
    ],
    env: {
      [GIT_CREDENTIAL_TOKEN_ENV_KEY]: credential.token,
      GH_TOKEN: credential.token,
      GITHUB_TOKEN: credential.token,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: String(configEntries.length),
      ...Object.fromEntries(configEntries.flatMap(([key, value], index) => [
        [`GIT_CONFIG_KEY_${index}`, key],
        [`GIT_CONFIG_VALUE_${index}`, value],
      ])),
    },
    source: credential.source,
    secretName: credential.secretName,
  };
}

const GIT_AUTH_FAILURE_PATTERN =
  /authentication failed|could not read username|could not read password|invalid username or password|terminal prompts disabled|repository not found|not accessible|permission denied|HTTP 40[13]|The requested URL returned error: 40[13]/i;

/**
 * Turn a failed git network operation into an actionable suffix for the error message.
 * Returns null when the failure does not look auth-related — a credential that was merely
 * present during an unrelated failure (network outage, target-path collision) must not be
 * blamed for it.
 */
export function describeGitAuthFailure(input: {
  error: string;
  used: { source: GitCredential["source"]; secretName: string | null } | null;
}): string | null {
  if (!GIT_AUTH_FAILURE_PATTERN.test(input.error)) {
    return null;
  }
  if (input.used) {
    const label = input.used.secretName
      ? `the ${input.used.secretName} company-secret GitHub credential`
      : input.used.source === "managed_connection"
        ? "the resolved GitHub connection"
      : "the server-environment GitHub credential";
    return `The operation authenticated with ${label}, which was rejected or lacks access to this repository.`;
  }
  return "No GitHub credential is configured — add a GITHUB_TOKEN or GH_TOKEN company secret in Settings → Secrets, or configure a local checkout cwd for this project workspace.";
}

type SecretServiceLike = ReturnType<typeof secretService>;

type GitCredentialSecretsDeps = {
  getByName: (
    companyId: string,
    name: string,
  ) => Promise<{ id: string } | null | undefined> | ReturnType<SecretServiceLike["getByName"]>;
  resolveSecretValue: SecretServiceLike["resolveSecretValue"];
  resolveUserSecretValue?: SecretServiceLike["resolveUserSecretValue"];
};

export type GitHubApiCredentialSource = "managed_connection" | "company_secret" | "server_env";

export type GitHubApiCredential = {
  token: string;
  source: GitHubApiCredentialSource;
  /** The company-secret name the token came from; null for a server-environment token. */
  secretName: string | null;
};

/**
 * Resolve a GitHub API credential for company-scoped, non-run work (for example the
 * external-object refresh sweep, which has no agent or responsible-user context).
 *
 * This is the background-safe subset of the git credential order: it reads a company
 * secret by well-known name, then the server process environment (`GITHUB_TOKEN`/`GH_TOKEN`)
 * that self-hosted operators already set for Git. It deliberately cannot resolve a managed
 * GitHub connection, because every managed grant is scoped to one agent or one person and a
 * background sweep has neither. Callers that have a run context must use
 * `createGitRemoteAuthProvider`/`resolveManagedGitHubCredential` instead so the managed
 * identity and its consent boundary are honored.
 *
 * The `source` matters to callers that show company data. A server-environment token is
 * instance-wide, so it can see repositories the company cannot. A caller must treat a
 * `server_env` token differently from a `company_secret` token and keep it away from
 * private repositories. Without any credential a caller runs anonymous, and anonymous
 * GitHub requests are capped at 60/hour, so a busy company is rate-limited into
 * misleading failures.
 */
export async function resolveGitHubApiCredential(
  db: Db,
  companyId: string,
  opts: { secretNames?: readonly string[]; env?: NodeJS.ProcessEnv; secrets?: GitCredentialSecretsDeps } = {},
): Promise<GitHubApiCredential | null> {
  const secrets = opts.secrets ?? secretService(db);
  for (const secretName of opts.secretNames ?? DEFAULT_GITHUB_TOKEN_SECRET_NAMES) {
    const secret = await Promise.resolve(secrets.getByName(companyId, secretName)).catch(() => null);
    if (!secret) continue;
    const token = await secrets
      .resolveSecretValue(companyId, secret.id, "latest")
      .then((value) => value.trim())
      .catch(() => "");
    if (token) return { token, source: "company_secret", secretName };
  }
  const env = opts.env ?? process.env;
  const envToken = env.GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim() || "";
  return envToken ? { token: envToken, source: "server_env", secretName: null } : null;
}

/**
 * Build the credential provider for one run. Resolution order: the managed GitHub identity
 * resolver, then a company secret by well-known name, then the server process environment
 * (`GITHUB_TOKEN`/`GH_TOKEN`) for self-hosted operators. A configured managed identity fails
 * closed instead of falling through to legacy credentials. The lookup is memoized per
 * provider instance so one run performs at most one secret resolution (and writes at most
 * one audit event) no matter how many git operations it authenticates.
 */
export function createIssueGitRemoteAuthProvider(db: Db, companyId: string, issueId: string,
  create: typeof createGitRemoteAuthProvider = createGitRemoteAuthProvider): GitRemoteAuthProvider {
  let provider: Promise<GitRemoteAuthProvider> | null = null;
  return async (remoteUrl: string) => {
    provider ??= db.select({ responsibleUserId: issues.responsibleUserId, assigneeAgentId: issues.assigneeAgentId }).from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
      .then(([issue]) => create(db, companyId, {
        issueId, responsibleUserId: issue?.responsibleUserId ?? null, agentId: issue?.assigneeAgentId ?? null,
      }));
    return (await provider)(remoteUrl);
  };
}

export function createGitRemoteAuthProvider(
  db: Db,
  companyId: string,
  context?: {
    issueId?: string | null;
    heartbeatRunId?: string | null;
    responsibleUserId?: string | null;
    agentId?: string | null;
  },
  deps?: {
    secrets?: GitCredentialSecretsDeps;
    env?: NodeJS.ProcessEnv;
    secretNames?: readonly string[];
  },
): GitRemoteAuthProvider {
  const secrets: GitCredentialSecretsDeps = deps?.secrets ?? secretService(db);
  const env = deps?.env ?? process.env;
  const secretNames = deps?.secretNames ?? DEFAULT_GITHUB_TOKEN_SECRET_NAMES;
  // Several GitHub accounts can be connected, so a credential is resolved
  // (and memoized) per repository owner rather than once per provider.
  const credentialPromises = new Map<string, Promise<GitCredential | null>>();

  const resolveCredential = async (repositoryOwner: string | null): Promise<GitCredential | null> => {
    // Unit callers historically pass a null DB through the typed test seam. Production
    // always supplies a real DB and therefore always checks managed identities before
    // considering legacy secrets or process environment credentials.
    const managed = db
      ? await resolveManagedGitHubCredential(db, secrets, companyId, { ...(context ?? {}), repositoryOwner })
      : { configured: false as const };
    if (managed.configured) {
      // No connected account is responsible for this owner. Never borrow
      // another account's token or a legacy company token; public
      // repositories still work anonymously.
      if (!managed.credential && "ownerUnmatched" in managed && managed.ownerUnmatched) return null;
      if (!managed.credential) throw new Error(managed.error ?? "Managed GitHub connection is unavailable");
      return managed.credential;
    }
    for (const secretName of secretNames) {
      const secret = await Promise.resolve(secrets.getByName(companyId, secretName)).catch(() => null);
      if (!secret) continue;
      // A resolution failure (inactive secret, provider outage) records its own failure audit
      // event; fall through to the next source instead of failing the whole git operation here.
      const token = await secrets
        .resolveSecretValue(companyId, secret.id, "latest", {
          accessContext: {
            consumerType: "system",
            consumerId: "workspace-git-credential",
            actorType: "system",
            issueId: context?.issueId ?? null,
            heartbeatRunId: context?.heartbeatRunId ?? null,
            responsibleUserId: context?.responsibleUserId ?? null,
          },
        })
        .then((value) => value.trim())
        .catch(() => "");
      if (token) return { token, source: "company_secret", secretName };
    }
    const envToken = env.GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim() || "";
    if (envToken) return { token: envToken, source: "server_env", secretName: null };
    return null;
  };

  return async (remoteUrl: string) => {
    if (!isSupportedGitHubRemoteUrl(remoteUrl)) return null;
    const repositoryOwner = githubOwnerFromRemoteUrl(remoteUrl);
    if (db && context?.heartbeatRunId && context.agentId) {
      const [run] = await db.select({ contextId: heartbeatRuns.activeIdentityContextId }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.id, context.heartbeatRunId), eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, context.agentId),
      ));
      if (run?.contextId) {
        const { resolveGitHubOperationCredentials } = await import("./github-operation-credentials.js");
        const result = await resolveGitHubOperationCredentials(db, {
          companyId, runId: context.heartbeatRunId, agentId: context.agentId, repositoryOwner,
        });
        if (result.status === "absent") {
          const credential = await resolveCredential(repositoryOwner);
          return credential ? buildGitAuthInvocation(credential) : null;
        }
        const anonymous = buildGitAuthInvocation({ token: "", source: "managed_connection", secretName: null });
        return { ...anonymous, env: {
          ...anonymous.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
          GIT_AUTHOR_NAME: "", GIT_AUTHOR_EMAIL: "", GIT_COMMITTER_NAME: "", GIT_COMMITTER_EMAIL: "",
          ...result.env,
        } };
      }
    }
    const key = repositoryOwner ?? "";
    let credentialPromise = credentialPromises.get(key);
    if (!credentialPromise) {
      credentialPromise = resolveCredential(repositoryOwner);
      credentialPromises.set(key, credentialPromise);
    }
    const credential = await credentialPromise;
    if (!credential) return null;
    return buildGitAuthInvocation(credential);
  };
}

function isGitHubPersonalAccessTokenConnection(connection: { config?: unknown; transportConfig?: unknown } | undefined) {
  const config = connection?.config && typeof connection.config === "object" ? connection.config as Record<string, unknown> : {};
  const transport = connection?.transportConfig && typeof connection.transportConfig === "object"
    ? connection.transportConfig as Record<string, unknown> : {};
  return (config.sourceTemplateKey ?? transport.sourceTemplateKey) === "github"
    && (config.connectionMethodKey ?? transport.connectionMethodKey) === "mcp-key";
}

type GitHubGrant = typeof connectionGrants.$inferSelect;
type GitHubGrantSecretRef = GitHubGrant["credentialSecretRefs"][number];

/** Resolve the GitHub token a grant stores, through the audited secret service. */
async function resolveGitHubGrantToken(
  db: Db,
  secrets: Pick<GitCredentialSecretsDeps, "resolveSecretValue" | "resolveUserSecretValue">,
  companyId: string,
  grant: GitHubGrant,
  accessRef: GitHubGrantSecretRef,
  options: {
    consumerId: string;
    personalAccessToken: boolean;
    context: { agentId?: string | null; issueId?: string | null; heartbeatRunId?: string | null; responsibleUserId?: string | null };
  },
): Promise<{ token: string } | { error: string }> {
  const accessContext = {
    consumerType: "system" as const,
    consumerId: options.consumerId,
    actorType: "system" as const,
    actorId: options.context.agentId ?? undefined,
    issueId: options.context.issueId ?? null,
    heartbeatRunId: options.context.heartbeatRunId ?? null,
    responsibleUserId: options.context.responsibleUserId ?? null,
  };
  let token: string;
  if (grant.kind === "user") {
    if (!grant.subjectUserId || !secrets.resolveUserSecretValue) {
      return { error: "The personal GitHub credential cannot be resolved" };
    }
    const [secret] = await db.select({
      userSecretDefinitionId: companySecrets.userSecretDefinitionId,
    }).from(companySecrets).where(and(
      eq(companySecrets.companyId, companyId),
      eq(companySecrets.id, accessRef.secretId),
      eq(companySecrets.ownerUserId, grant.subjectUserId),
    )).limit(1);
    if (!secret?.userSecretDefinitionId) return { error: "The personal GitHub credential is invalid" };
    const resolved = await secrets.resolveUserSecretValue(companyId, {
      definitionId: secret.userSecretDefinitionId,
      responsibleUserId: grant.subjectUserId,
      version: accessRef.versionSelector ?? "latest",
      required: true,
    }, accessContext);
    if (!resolved) return { error: "The personal GitHub credential is missing" };
    token = resolved.value;
  } else {
    token = await secrets.resolveSecretValue(companyId, accessRef.secretId, accessRef.versionSelector ?? "latest", { accessContext });
  }
  if (options.personalAccessToken) token = token.trim().replace(/^(?:bearer|token)\s+/i, "").trim();
  if (!token) return { error: "The personal GitHub credential is missing" };
  return { token };
}

const PERSONAL_TOKEN_OWNERS_TTL_MS = 10 * 60_000;
const PERSONAL_TOKEN_OWNERS_RETRY_MS = 60_000;
const personalTokenOwnerCache = new Map<string, { owners: string[]; expiresAt: number }>();

/** For tests: forget detected personal access token owners. */
export function clearPersonalTokenOwnerCache() {
  personalTokenOwnerCache.clear();
}

/**
 * Owners (users and organizations) whose repositories a personal access token
 * can reach. A token connection has no access snapshot, so without this an
 * empty "Responsible GitHub owners" setting would leave it handling nothing
 * once a second GitHub account is connected. Results are cached per token
 * version; a failed lookup is retried after a minute and claims no owners.
 */
async function detectPersonalTokenOwners(
  db: Db,
  companyId: string,
  grant: GitHubGrant,
  context: { agentId?: string | null; responsibleUserId?: string | null },
  request: typeof fetch,
): Promise<string[]> {
  const accessRef = grant.credentialSecretRefs.find((ref) => ref.configPath === "credentials.authorization");
  if (!accessRef) return [];
  const [secret] = await db.select({ updatedAt: companySecrets.updatedAt, latestVersion: companySecrets.latestVersion })
    .from(companySecrets)
    .where(and(eq(companySecrets.companyId, companyId), eq(companySecrets.id, accessRef.secretId)))
    .limit(1);
  if (!secret) return [];
  const key = `${grant.id}:${accessRef.secretId}:${secret.latestVersion}:${new Date(secret.updatedAt).getTime()}`;
  const now = Date.now();
  const cached = personalTokenOwnerCache.get(key);
  if (cached && cached.expiresAt > now) return cached.owners;
  let owners: string[] = [];
  let ttl = PERSONAL_TOKEN_OWNERS_RETRY_MS;
  try {
    const resolved = await resolveGitHubGrantToken(db, secretService(db), companyId, grant, accessRef, {
      consumerId: "github-owner-routing",
      personalAccessToken: true,
      context,
    });
    if ("token" in resolved) {
      const repositories = await loadGitHubTokenRepositories({ Authorization: `Bearer ${resolved.token}` }, request);
      owners = [...new Set(repositories
        .map((repository) => normalizeGitHubOwner(repository.fullName.split("/")[0]))
        .filter((owner): owner is string => Boolean(owner)))].sort();
      ttl = PERSONAL_TOKEN_OWNERS_TTL_MS;
    }
  } catch {
    // Provider and credential errors can carry secrets; an unreachable token
    // simply claims no owners until the next attempt.
  }
  for (const [entryKey, entry] of personalTokenOwnerCache) {
    if (entry.expiresAt <= now || entryKey.startsWith(`${grant.id}:`)) personalTokenOwnerCache.delete(entryKey);
  }
  personalTokenOwnerCache.set(key, { owners, expiresAt: now + ttl });
  return owners;
}

export async function resolveManagedGitHubIdentitySelection(
  db: Db,
  companyId: string,
  context: {
    responsibleUserId?: string | null;
    agentId?: string | null;
    allowStandingDelegation?: boolean;
    excludeGrantId?: string;
    explicitGrantId?: string;
    /** GitHub user or organization that owns the repository this operation targets. */
    repositoryOwner?: string | null;
    /** `catalog` picks a stable connection for tool listings instead of failing. */
    ownerRoutingMode?: "operation" | "catalog";
    /** The connection whose own tools or data an ownerless operation uses. */
    routedConnectionId?: string | null;
    /** Tests only: the GitHub API client used to detect token owners. */
    githubFetch?: typeof fetch;
  },
): Promise<{
  configured: boolean;
  identitySource?: "personal" | "dedicated";
  grant?: typeof connectionGrants.$inferSelect;
  error?: string;
  /** The named owner is not handled by any connected GitHub account. */
  ownerUnmatched?: boolean;
  /** Routing between GitHub accounts refused the operation; `error` is safe to show agents. */
  routingRefused?: boolean;
}> {
  const connections = await db.select().from(toolConnections).where(and(
    eq(toolConnections.companyId, companyId),
    or(
      sql`${toolConnections.config}->'sourceTemplateKey' = '"github"'::jsonb`,
      sql`${toolConnections.transportConfig}->'sourceTemplateKey' = '"github"'::jsonb`,
    ),
  ));
  const githubConnections = connections.filter((connection) => {
    const config = connection.config && typeof connection.config === "object" ? connection.config as Record<string, unknown> : {};
    const transportConfig = connection.transportConfig && typeof connection.transportConfig === "object"
      ? connection.transportConfig as Record<string, unknown>
      : {};
    return config.sourceTemplateKey === "github" || transportConfig.sourceTemplateKey === "github";
  });
  if (githubConnections.length === 0) return { configured: false };

  const connectionIds = githubConnections.map((connection) => connection.id);
  const installs = await db.select().from(toolConnectionInstalls).where(and(
    eq(toolConnectionInstalls.companyId, companyId),
    inArray(toolConnectionInstalls.connectionId, connectionIds),
  ));
  const eligibleConnectionIds = new Set(githubConnections.filter((connection) => installs.some((install) =>
    install.connectionId === connection.id && (
      (install.targetType === "company" && install.targetId === companyId)
      || (install.targetType === "agent" && install.targetId === context.agentId)
    )
  )).map((connection) => connection.id));
  // A GitHub connection installed only for another agent is not configured for
  // this run. Treating the company-wide connection as configured here would
  // make unrelated agents fail before their adapter starts and would also
  // suppress their otherwise-eligible legacy credential fallback.
  if (eligibleConnectionIds.size === 0) return { configured: false };
  const grants = await db.select().from(connectionGrants).where(and(
    eq(connectionGrants.companyId, companyId),
    inArray(connectionGrants.connectionId, [...eligibleConnectionIds]),
    context.explicitGrantId ? eq(connectionGrants.id, context.explicitGrantId) : undefined,
    or(eq(connectionGrants.kind, "agent"), eq(connectionGrants.kind, "user")),
  ));
  const dedicated = context.agentId
    ? grants.filter((grant) => grant.kind === "agent" && grant.subjectAgentId === context.agentId)
    : [];
  // Connections are already restricted above to the owner-selected install
  // targets. Within that consent boundary the server-resolved responsible user
  // is authoritative; standing delegation is only an ownerless-run fallback.
  const personal = context.responsibleUserId
    ? grants.filter((grant) => grant.kind === "user" && grant.subjectUserId === context.responsibleUserId)
    : [];
  const delegated = context.allowStandingDelegation !== false && !context.responsibleUserId && context.agentId
    ? await db.select({ grantId: connectionGrantDelegations.grantId }).from(connectionGrantDelegations).where(and(
        eq(connectionGrantDelegations.companyId, companyId),
        eq(connectionGrantDelegations.agentId, context.agentId),
        inArray(connectionGrantDelegations.grantId, grants.map((grant) => grant.id)),
      )).then((rows) => {
        const delegatedIds = new Set(rows.map((row) => row.grantId));
        return grants.filter((grant) => grant.kind === "user" && delegatedIds.has(grant.id));
      })
    : [];
  const tierCandidates = dedicated.length > 0 ? dedicated : personal.length > 0 ? personal : delegated;
  const identitySource = dedicated.length > 0 ? "dedicated" as const : "personal" as const;
  // Several GitHub accounts can be connected at once. Send each operation to
  // the connection responsible for the repository owner, and fail clearly
  // rather than borrowing another account's credential.
  // A personal access token has no access snapshot. When the operation names
  // an owner and its connection lists none, use the owners the token reaches.
  const detectedOwners = new Map<string, string[]>();
  if (!context.explicitGrantId && normalizeGitHubOwner(context.repositoryOwner) && tierCandidates.length > 1) {
    const connectionById = new Map(githubConnections.map((connection) => [connection.id, connection]));
    await Promise.all(tierCandidates.map(async (grant) => {
      const connection = connectionById.get(grant.connectionId);
      if (!connection || !isGitHubPersonalAccessTokenConnection(connection)) return;
      if (configuredGitHubOwners(connection) !== null || grantGitHubOwners(grant).length > 0) return;
      detectedOwners.set(grant.id, await detectPersonalTokenOwners(db, companyId, grant, context, context.githubFetch ?? fetch));
    }));
  }
  const routing = context.explicitGrantId
    ? { candidates: tierCandidates }
    : routeGitHubCandidatesByOwner({
        candidates: tierCandidates,
        connections: githubConnections,
        owner: context.repositoryOwner ?? null,
        mode: context.ownerRoutingMode,
        connectionId: context.routedConnectionId ?? null,
        detectedOwners,
      });
  if (routing.error) {
    return {
      configured: true, identitySource, error: routing.error, routingRefused: true,
      ...(routing.ownerUnmatched ? { ownerUnmatched: true } : {}),
    };
  }
  const candidates = routing.candidates;
  // Reconnecting can create another connection/grant for the same GitHub
  // account. Ambiguity is about provider identities, not the number of rows.
  // Only trust GitHub's stable account ID; equal logins or missing metadata
  // cannot establish that two grants belong to the same person.
  const githubUserIds = candidates.map((candidate) => candidate.providerTenant?.github?.userId?.trim());
  if (candidates.length === 0 || (candidates.length > 1 && (
    githubUserIds.some((id) => !id) || new Set(githubUserIds).size !== 1
  ))) {
    return {
      configured: true, identitySource,
      error: candidates.length === 0
        ? "No managed GitHub identity is available for this run"
        : "More than one managed GitHub identity matches this run",
    };
  }
  const credentialIds = candidates.flatMap((grant) => grant.credentialSecretRefs
    .filter((ref) => ref.configPath === "oauth.access_token").map((ref) => ref.secretId));
  const credentialRecords = candidates.length > 1 && credentialIds.length > 0
    ? await db.select({
        id: companySecrets.id, status: companySecrets.status, deletedAt: companySecrets.deletedAt,
        scope: companySecrets.scope, ownerUserId: companySecrets.ownerUserId,
        definitionStatus: userSecretDefinitions.status, definitionDeletedAt: userSecretDefinitions.deletedAt,
      }).from(companySecrets).leftJoin(userSecretDefinitions, and(
        eq(userSecretDefinitions.id, companySecrets.userSecretDefinitionId),
        eq(userSecretDefinitions.companyId, companyId),
      )).where(and(
        eq(companySecrets.companyId, companyId), inArray(companySecrets.id, credentialIds),
      ))
    : [];
  const hasCredentialRecord = (grant: typeof connectionGrants.$inferSelect) => {
    if (candidates.length === 1) return true;
    const github = grant.providerTenant?.github;
    const ref = grant.credentialSecretRefs.find((ref) => ref.configPath === "oauth.access_token");
    return Boolean(github && github.installationCount > 0 && github.repositoryCount > 0 && ref
      && credentialRecords.some((secret) => secret.id === ref.secretId
        && secret.status === "active" && !secret.deletedAt
        && (grant.kind === "user"
          ? secret.scope === "user" && secret.ownerUserId === grant.subjectUserId
            && secret.definitionStatus === "active" && !secret.definitionDeletedAt
          : secret.scope === "company")));
  };
  const isAvailable = (grant: typeof connectionGrants.$inferSelect) =>
    grant.status === "active" && hasCredentialRecord(grant) && githubConnections.some((connection) =>
      connection.id === grant.connectionId && connection.enabled && connection.status === "active",
    );
  // Prefer an available, healthy authorization for this account, then the newest
  // connection grant. Do not rank by updatedAt: refreshes/webhooks change it.
  // Select one grant, preserving its credential and connection policy intact.
  const healthRank = (candidate: typeof connectionGrants.$inferSelect) => {
    const health = githubConnections.find((connection) => connection.id === candidate.connectionId)?.healthStatus;
    return health === "ok" || health === "healthy" ? 2 : health === "unknown" ? 1 : 0;
  };
  const grant = candidates.filter((candidate) => candidate.id !== context.excludeGrantId).sort((a, b) =>
    Number(isAvailable(b)) - Number(isAvailable(a))
    || healthRank(b) - healthRank(a)
    || b.createdAt.getTime() - a.createdAt.getTime()
    || a.id.localeCompare(b.id),
  )[0]!;
  if (!grant) return { configured: true, identitySource, error: "No alternative managed GitHub authorization is available" };
  const connection = githubConnections.find((candidate) => candidate.id === grant.connectionId);
  if (!connection?.enabled || connection.status !== "active") {
    return { configured: true, identitySource, error: "The managed GitHub connection is unavailable" };
  }
  if (grant.status !== "active") return { configured: true, identitySource, error: "The managed GitHub identity must be reconnected" };
  return { configured: true, identitySource, grant };
}

export async function filterResolvedGitHubConnectionsForRun<T extends {
  id: string;
  config?: unknown;
  transportConfig?: unknown;
}>(input: {
  db: Db;
  companyId: string;
  agentId: string;
  responsibleUserId?: string | null;
  connections: T[];
}): Promise<T[]> {
  const githubConnections = input.connections.filter((connection) => {
    const config = connection.config && typeof connection.config === "object"
      ? connection.config as Record<string, unknown>
      : {};
    const transportConfig = connection.transportConfig && typeof connection.transportConfig === "object"
      ? connection.transportConfig as Record<string, unknown>
      : {};
    return config.sourceTemplateKey === "github" || transportConfig.sourceTemplateKey === "github";
  });
  if (githubConnections.length === 0) return input.connections;
  // One set of GitHub tools is listed even when several accounts are
  // connected; the gateway routes each call to the responsible connection.
  const selection = await resolveManagedGitHubIdentitySelection(input.db, input.companyId, {
    agentId: input.agentId,
    responsibleUserId: input.responsibleUserId ?? null,
    ownerRoutingMode: "catalog",
  });
  const selectedConnectionId = selection.grant?.connectionId ?? null;
  const githubIds = new Set(githubConnections.map((connection) => connection.id));
  return input.connections.filter((connection) =>
    !githubIds.has(connection.id) || connection.id === selectedConnectionId,
  );
}

export async function resolveManagedGitHubCredential(
  db: Db,
  secrets: GitCredentialSecretsDeps,
  companyId: string,
  context: {
    issueId?: string | null;
    heartbeatRunId?: string | null;
    responsibleUserId?: string | null;
    agentId?: string | null;
    allowStandingDelegation?: boolean;
    explicitGrantId?: string;
    repositoryOwner?: string | null;
  },
): Promise<{ configured: boolean; identitySource?: "personal" | "dedicated"; credential?: GitCredential; error?: string; ownerUnmatched?: boolean }> {
  const selection = await resolveManagedGitHubIdentitySelection(db, companyId, context);
  if (!selection.configured) return { configured: false };
  if (!selection.grant) {
    return {
      configured: true, identitySource: selection.identitySource, error: selection.error,
      ...(selection.ownerUnmatched ? { ownerUnmatched: true } : {}),
    };
  }
  const acquire = async (selection: Awaited<ReturnType<typeof resolveManagedGitHubIdentitySelection>>) => {
    let grant = selection.grant!;
    const [selectedConnection] = await db.select({ config: toolConnections.config, transportConfig: toolConnections.transportConfig })
      .from(toolConnections).where(and(eq(toolConnections.companyId, companyId), eq(toolConnections.id, grant.connectionId)));
    if (grant.kind === "user" && grant.subjectUserId) {
      const [membership] = await db.select({ id: companyMemberships.id, role: companyMemberships.membershipRole }).from(companyMemberships).where(and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, grant.subjectUserId),
        eq(companyMemberships.status, "active"),
      )).limit(1);
      if (!membership || membership.role === "viewer") return { configured: true, identitySource: selection.identitySource, error: "The managed GitHub identity owner is not an authorized company member" };
    }
    const expiresAt = grant.providerTenant?.oauth?.accessTokenExpiresAt;
    const refreshedAt = grant.providerTenant?.oauth?.refreshedAt;
    const expiryMs = typeof expiresAt === "string" ? Date.parse(expiresAt) : Number.NaN;
    const refreshedMs = typeof refreshedAt === "string" ? Date.parse(refreshedAt) : Number.NaN;
    if (Number.isFinite(expiryMs) && (
      expiryMs <= Date.now() + 60 * 60_000
      || !Number.isFinite(refreshedMs)
      || refreshedMs <= Date.now() - 30 * 24 * 60 * 60_000
    )) {
      grant = await toolAccessService(db).refreshOAuthGrantCredentials({
        companyId,
        connectionId: grant.connectionId,
        grantId: grant.id,
        actor: { actorType: "system", actorId: "workspace-git-credential" },
        issueId: context.issueId,
        heartbeatRunId: context.heartbeatRunId,
      });
    }
    // A personal access token connection stores the token GitHub's MCP server
    // receives as its Authorization header. The same token authenticates Git
    // and gh for that account; it has no OAuth access snapshot.
    const personalAccessToken = isGitHubPersonalAccessTokenConnection(selectedConnection);
    const accessRef = grant.credentialSecretRefs.find((ref) => ref.configPath === "oauth.access_token")
      ?? (personalAccessToken
        ? grant.credentialSecretRefs.find((ref) => ref.configPath === "credentials.authorization")
        : undefined);
    const github = grant.providerTenant?.github;
    if (!accessRef || (!github && !personalAccessToken)) return { configured: true, identitySource: selection.identitySource, error: "The managed GitHub identity is incomplete" };
    if (github && !personalAccessToken && (github.installationCount < 1 || github.repositoryCount < 1)) {
      return { configured: true, identitySource: selection.identitySource, error: "The managed GitHub identity no longer has repository access" };
    }
    const resolvedToken = await resolveGitHubGrantToken(db, secrets, companyId, grant, accessRef, {
      consumerId: "workspace-git-credential",
      personalAccessToken,
      context,
    });
    if ("error" in resolvedToken) return { configured: true, identitySource: selection.identitySource, error: resolvedToken.error };
    const token = resolvedToken.token;
    return {
      configured: true, identitySource: selection.identitySource,
      credential: {
        token,
        source: "managed_connection" as const,
        secretName: null,
        ...(github?.userId && github.login ? { githubIdentity: { userId: github.userId, login: github.login } } : {}),
        identitySource: grant.kind === "agent" ? "dedicated" as const : "personal" as const,
        connectionId: grant.connectionId,
        grantId: grant.id,
      },
    };
  };
  let failure: { configured: boolean; identitySource?: "personal" | "dedicated"; error?: string };
  try {
    const result = await acquire(selection);
    if (result.credential) return result;
    failure = result;
  } catch {
    failure = { configured: true, identitySource: selection.identitySource, error: "GitHub credentials are temporarily unavailable" };
  }
  if (context.explicitGrantId) return failure;
  // Retry credential acquisition, never the GitHub operation. An alternate
  // authorization must still belong to this exact principal and account.
  const alternate = await resolveManagedGitHubIdentitySelection(db, companyId, {
    ...context, excludeGrantId: selection.grant.id,
  });
  const accountId = selection.grant.providerTenant?.github?.userId;
  if (!accountId || !alternate.grant || alternate.identitySource !== selection.identitySource
    || alternate.grant.providerTenant?.github?.userId !== accountId
    || alternate.grant.subjectUserId !== selection.grant.subjectUserId
    || alternate.grant.subjectAgentId !== selection.grant.subjectAgentId) return failure;
  try { return await acquire(alternate); } catch { return failure; }
}
