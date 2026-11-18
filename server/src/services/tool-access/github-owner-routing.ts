/**
 * Routing between several GitHub connections in one company.
 *
 * A company can connect more than one GitHub account (for example a personal
 * account and a separate work account). Each GitHub operation is sent to the
 * connection responsible for the repository owner (user or organization) it
 * targets. Owners come from the connection's "Responsible GitHub owners"
 * setting; when that setting is empty they come from the access snapshot of
 * the connection's authorization, or for a personal access token (which has
 * no snapshot) from the repositories the token can reach. `*` marks a
 * connection as the default for
 * operations that name no owner, or an owner no other connection claims.
 *
 * Routing never falls back to an arbitrary connection: an owner that no
 * connection is responsible for is an explicit error, so one account's
 * credential is never used for another account's repositories by accident.
 */

export const GITHUB_OWNER_WILDCARD = "*";
export const GITHUB_OWNERS_SETTING = "githubOwners";

const OWNER_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38})$/;

type ConnectionLike = {
  id: string;
  config?: unknown;
  transportConfig?: unknown;
  createdAt?: Date | string | null;
};

type GrantLike = {
  id: string;
  connectionId: string;
  providerTenant?: unknown;
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Lower-cased GitHub login, or null when the value is not a valid login. */
export function normalizeGitHubOwner(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const owner = value.trim().replace(/^@/, "").toLowerCase();
  return OWNER_PATTERN.test(owner) ? owner : null;
}

/** Parse a comma/whitespace separated owner list. Invalid entries are dropped. */
export function parseGitHubOwnerList(value: unknown): string[] {
  const entries = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\s,;]+/)
      : [];
  const owners = new Set<string>();
  for (const entry of entries) {
    if (typeof entry !== "string") continue;
    if (entry.trim() === GITHUB_OWNER_WILDCARD) {
      owners.add(GITHUB_OWNER_WILDCARD);
      continue;
    }
    const owner = normalizeGitHubOwner(entry);
    if (owner) owners.add(owner);
  }
  return [...owners];
}

/** Invalid entries in a user-entered owner list, for validation messages. */
export function invalidGitHubOwnerEntries(value: string): string[] {
  return value
    .split(/[\s,;]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry && entry !== GITHUB_OWNER_WILDCARD && !normalizeGitHubOwner(entry));
}

function isGitHubConnection(connection: ConnectionLike): boolean {
  return record(connection.config).sourceTemplateKey === "github"
    || record(connection.transportConfig).sourceTemplateKey === "github";
}

/** The owners an operator configured on this connection, or null when unset. */
export function configuredGitHubOwners(connection: ConnectionLike): string[] | null {
  if (!isGitHubConnection(connection)) return null;
  const config = record(connection.config);
  const raw = record(config.methodConfig)[GITHUB_OWNERS_SETTING] ?? config[GITHUB_OWNERS_SETTING];
  const owners = parseGitHubOwnerList(raw);
  return owners.length > 0 ? owners : null;
}

/** Owners visible in an authorization's GitHub access snapshot. */
export function grantGitHubOwners(grant: GrantLike): string[] {
  const github = record(record(grant.providerTenant).github);
  const owners = new Set<string>();
  const add = (value: unknown) => {
    const owner = normalizeGitHubOwner(value);
    if (owner) owners.add(owner);
  };
  add(github.login);
  for (const login of Array.isArray(github.installationOwnerLogins) ? github.installationOwnerLogins : []) add(login);
  for (const repository of Array.isArray(github.repositories) ? github.repositories : []) {
    const fullName = record(repository).fullName;
    if (typeof fullName === "string") add(fullName.split("/")[0]);
  }
  return [...owners];
}

/** Owner of a github.com remote (https, scp-style, or ssh), or null. */
export function githubOwnerFromRemoteUrl(remoteUrl: unknown): string | null {
  if (typeof remoteUrl !== "string") return null;
  const value = remoteUrl.trim();
  const scp = /^git@(?:www\.)?github\.com:\/?([^/\s]+)\/[^\s]+$/i.exec(value);
  if (scp) return normalizeGitHubOwner(scp[1]);
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (host !== "github.com" && host !== "www.github.com" && host !== "api.github.com") return null;
    const segments = url.pathname.split("/").filter(Boolean);
    const owner = host === "api.github.com" && segments[0] === "repos" ? segments[1] : segments[0];
    return normalizeGitHubOwner(owner);
  } catch {
    return null;
  }
}

/** Owner from an `owner/name` repository reference. */
function ownerFromFullName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^\s*([A-Za-z0-9][A-Za-z0-9-]*)\/[A-Za-z0-9_.-]+\s*$/.exec(value);
  return match ? normalizeGitHubOwner(match[1]) : githubOwnerFromRemoteUrl(value);
}

/**
 * The repository owner a GitHub MCP tool call targets, or null when the call
 * names none (for example `get_me` or an unqualified search).
 */
export function githubOwnerFromToolArguments(parameters: unknown): string | null {
  const params = record(parameters);
  const direct = normalizeGitHubOwner(params.owner);
  if (direct) return direct;
  for (const key of ["repo", "repository", "full_name", "fullName", "repo_full_name"]) {
    const owner = ownerFromFullName(params[key]);
    if (owner) return owner;
  }
  for (const key of ["url", "html_url", "pullRequestUrl", "issueUrl"]) {
    const owner = githubOwnerFromRemoteUrl(params[key]);
    if (owner) return owner;
  }
  const organization = normalizeGitHubOwner(params.organization ?? params.org);
  if (organization) return organization;
  if (typeof params.query === "string") {
    const repo = /(?:^|\s)repo:([A-Za-z0-9][A-Za-z0-9-]*)\//i.exec(params.query);
    if (repo) return normalizeGitHubOwner(repo[1]);
    const owner = /(?:^|\s)(?:org|user|owner):([A-Za-z0-9][A-Za-z0-9-]*)/i.exec(params.query);
    if (owner) return normalizeGitHubOwner(owner[1]);
  }
  return null;
}

function identityKey(grant: GrantLike): string {
  const userId = record(record(grant.providerTenant).github).userId;
  return typeof userId === "string" && userId.trim() ? `github:${userId.trim()}` : `connection:${grant.connectionId}`;
}

export type GitHubOwnerRouting<G> = {
  candidates: G[];
  /** Set when routing could not choose; the message is safe to show agents. */
  error?: string;
  /** The operation named an owner that no connection is responsible for. */
  ownerUnmatched?: boolean;
};

/**
 * Narrow the candidate authorizations for one GitHub operation to the
 * connection responsible for `owner`.
 *
 * Routing applies when the candidates belong to more than one GitHub account,
 * or when any candidate connection lists responsible owners. Otherwise a
 * single connected account keeps serving every operation, as before.
 *
 * `mode: "catalog"` is for choosing which connection's tool descriptors an
 * agent sees. Every call is routed again by its arguments, so the catalog
 * only needs one stable choice: the default (`*`) connection, else the oldest.
 */
export function routeGitHubCandidatesByOwner<G extends GrantLike>(input: {
  candidates: G[];
  connections: ConnectionLike[];
  owner?: string | null;
  mode?: "operation" | "catalog";
  /** For an ownerless operation on one connection's own tools or data. */
  connectionId?: string | null;
  /**
   * Owners a credential can reach, by grant id, for authorizations without an
   * access snapshot (personal access tokens). Used like the snapshot: only
   * when the connection lists no responsible owners.
   */
  detectedOwners?: ReadonlyMap<string, readonly string[]>;
}): GitHubOwnerRouting<G> {
  const { candidates } = input;
  if (candidates.length === 0) return { candidates };
  const connectionById = new Map(input.connections.map((connection) => [connection.id, connection]));
  const configured = (grant: G) => {
    const connection = connectionById.get(grant.connectionId);
    return connection ? configuredGitHubOwners(connection) : null;
  };
  const multipleAccounts = new Set(candidates.map(identityKey)).size > 1;
  const anyConfigured = candidates.some((grant) => configured(grant) !== null);
  if (!multipleAccounts && !anyConfigured) return { candidates };

  const wildcard = candidates.filter((grant) => configured(grant)?.includes(GITHUB_OWNER_WILDCARD));
  const owner = normalizeGitHubOwner(input.owner);
  if (owner) {
    const explicit = candidates.filter((grant) => configured(grant)?.includes(owner));
    if (explicit.length > 0) return { candidates: explicit };
    // A connection with configured owners is responsible for exactly those
    // owners. Only connections without a setting fall back to their snapshot.
    const reachable = (grant: G) => grantGitHubOwners(grant).includes(owner)
      || Boolean(input.detectedOwners?.get(grant.id)?.includes(owner));
    const derived = candidates.filter((grant) => configured(grant) === null && reachable(grant));
    if (derived.length > 0) return { candidates: derived };
    if (wildcard.length > 0) return { candidates: wildcard };
    if (!multipleAccounts && candidates.every((grant) => configured(grant) === null)) return { candidates };
    return {
      candidates: [],
      ownerUnmatched: true,
      error: `No GitHub connection is responsible for "${owner}". Add ${owner} to the Responsible GitHub owners setting of the GitHub connection that should handle it.`,
    };
  }
  if (input.connectionId) {
    const own = candidates.filter((grant) => grant.connectionId === input.connectionId);
    if (own.length > 0) return { candidates: own };
  }
  if (wildcard.length > 0) return { candidates: wildcard };
  if (!multipleAccounts) return { candidates };
  if (input.mode === "catalog") {
    const created = (grant: G) => {
      const value = connectionById.get(grant.connectionId)?.createdAt;
      const time = value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : Number.NaN;
      return Number.isFinite(time) ? time : Number.MAX_SAFE_INTEGER;
    };
    const first = [...candidates].sort((a, b) => created(a) - created(b) || a.connectionId.localeCompare(b.connectionId))[0]!;
    return { candidates: candidates.filter((grant) => grant.connectionId === first.connectionId) };
  }
  return {
    candidates: [],
    error: "More than one GitHub account is connected and this operation does not name a repository owner. Name the repository owner (for example owner/repository), or add * to one GitHub connection's Responsible GitHub owners setting to make it the default.",
  };
}
