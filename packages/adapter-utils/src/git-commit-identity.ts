import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Who Paperclip names as author and committer on the commits it makes or brokers.
 *
 * Commits belong to the operator's developer identity, never to Paperclip or an
 * agent. The first available source wins:
 *
 *   1. explicit operator configuration (`PAPERCLIP_GIT_COMMIT_NAME` and
 *      `PAPERCLIP_GIT_COMMIT_EMAIL`),
 *   2. the host's Git configuration (`user.name`/`user.email`; a repository's
 *      own setting outranks the global one, as in Git itself),
 *   3. the connected GitHub account (its login and GitHub noreply address),
 *   4. Paperclip, only so that Git does not refuse to commit with no identity.
 *
 * Only identity keys are read. Credentials, credential helpers and gh
 * authentication files are never consulted.
 */
export type GitCommitIdentitySource = "explicit" | "host_git_config" | "github_connection" | "paperclip_fallback";

export type GitCommitIdentity = { name: string; email: string; source: GitCommitIdentitySource };

export const GIT_COMMIT_NAME_ENV = "PAPERCLIP_GIT_COMMIT_NAME";
export const GIT_COMMIT_EMAIL_ENV = "PAPERCLIP_GIT_COMMIT_EMAIL";

export const PAPERCLIP_FALLBACK_GIT_IDENTITY: GitCommitIdentity = Object.freeze({
  name: "Paperclip",
  email: "noreply@paperclip.ing",
  source: "paperclip_fallback",
});

type IdentityParts = { name?: string | null; email?: string | null };

/**
 * A value is accepted only when Git would store it verbatim: no control
 * characters (so it cannot break a config file or header) and no angle
 * brackets (Git strips them, which would silently change the identity).
 */
function cleanIdentityValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 256 || /[\u0000-\u001f\u007f<>]/u.test(trimmed)) return null;
  return trimmed;
}

function completeIdentity(parts: IdentityParts | null | undefined, source: GitCommitIdentitySource): GitCommitIdentity | null {
  const name = cleanIdentityValue(parts?.name);
  const email = cleanIdentityValue(parts?.email);
  if (!name || !email) return null;
  // A configuration that only repeats Paperclip's own placeholder (for example
  // a launcher's scratch gitconfig inherited by a process) is not a person.
  if (isPaperclipPlaceholderIdentity({ name, email })) return null;
  return { name, email, source };
}

export function isPaperclipPlaceholderIdentity(identity: IdentityParts): boolean {
  const email = identity.email?.trim().toLowerCase() ?? "";
  return email === PAPERCLIP_FALLBACK_GIT_IDENTITY.email
    || email.endsWith("@paperclip.invalid")
    || (identity.name?.trim() === PAPERCLIP_FALLBACK_GIT_IDENTITY.name && !email);
}

export function readExplicitGitCommitIdentity(env: NodeJS.ProcessEnv = process.env): GitCommitIdentity | null {
  return completeIdentity({ name: env[GIT_COMMIT_NAME_ENV], email: env[GIT_COMMIT_EMAIL_ENV] }, "explicit");
}

export function githubNoreplyIdentity(account: { login?: string | null; userId?: string | number | null } | null | undefined): GitCommitIdentity | null {
  const login = cleanIdentityValue(account?.login);
  if (!login || !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\[bot\])?$/u.test(login)) return null;
  const userId = account?.userId === null || account?.userId === undefined ? "" : String(account.userId).trim();
  const email = /^[A-Za-z0-9_-]+$/u.test(userId) ? `${userId}+${login}@users.noreply.github.com` : `${login}@users.noreply.github.com`;
  return completeIdentity({ name: login, email }, "github_connection");
}

/** Pick the first available identity in the documented order. */
export function resolveGitCommitIdentity(input: {
  explicit?: GitCommitIdentity | null;
  hostGitConfig?: GitCommitIdentity | null;
  github?: GitCommitIdentity | null;
}): GitCommitIdentity {
  return input.explicit ?? input.hostGitConfig ?? input.github ?? PAPERCLIP_FALLBACK_GIT_IDENTITY;
}

function readGitConfigValue(args: string[], key: string, env: NodeJS.ProcessEnv): string | null {
  try {
    const result = spawnSync("git", [...args, "--get", key], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
      env: {
        ...env,
        GIT_TERMINAL_PROMPT: "0",
        // Command-line style overrides and repository discovery must not leak in.
        GIT_CONFIG_COUNT: "0",
        GIT_CONFIG_PARAMETERS: "",
        GIT_DIR: undefined,
        GIT_WORK_TREE: undefined,
      },
    });
    return result.status === 0 ? String(result.stdout).trim() || null : null;
  } catch {
    return null;
  }
}

/**
 * The host user's global Git configuration files, in Git's own precedence
 * order (later files win). They are named directly with `--file`, so a
 * scratch `GIT_CONFIG_GLOBAL` that a Paperclip launcher set for one operation
 * cannot stand in for the person's configuration.
 */
function globalGitConfigFiles(env: NodeJS.ProcessEnv): string[] {
  const configured = env.GIT_CONFIG_GLOBAL?.trim();
  if (configured) {
    return configured === "/dev/null" || configured.includes("paperclip-github-operation-") ? [] : [configured];
  }
  const home = env.HOME?.trim() || os.homedir();
  const xdg = env.XDG_CONFIG_HOME?.trim() || (home ? path.join(home, ".config") : "");
  return [xdg ? path.join(xdg, "git", "config") : "", home ? path.join(home, ".gitconfig") : ""]
    .filter((file) => file && fs.existsSync(file));
}

function readGlobalGitIdentity(env: NodeJS.ProcessEnv): GitCommitIdentity | null {
  let name: string | null = null;
  let email: string | null = null;
  for (const file of globalGitConfigFiles(env)) {
    name = readGitConfigValue(["config", "--includes", "--file", file], "user.name", env) ?? name;
    email = readGitConfigValue(["config", "--includes", "--file", file], "user.email", env) ?? email;
  }
  return completeIdentity({ name, email }, "host_git_config");
}

function readRepositoryGitIdentity(repositoryDir: string, env: NodeJS.ProcessEnv): GitCommitIdentity | null {
  const args = ["-C", repositoryDir, "config", "--local", "--includes"];
  return completeIdentity({
    name: readGitConfigValue(args, "user.name", env),
    email: readGitConfigValue(args, "user.email", env),
  }, "host_git_config");
}

export type HostGitIdentityReader = (input: { repositoryDir?: string | null; env: NodeJS.ProcessEnv }) => GitCommitIdentity | null;

const defaultHostGitIdentityReader: HostGitIdentityReader = ({ repositoryDir, env }) =>
  (repositoryDir ? readRepositoryGitIdentity(repositoryDir, env) : null) ?? readGlobalGitIdentity(env);

let hostGitIdentityReader: HostGitIdentityReader = defaultHostGitIdentityReader;
const HOST_IDENTITY_CACHE_MS = 30_000;
const hostIdentityCache = new Map<string, { at: number; identity: GitCommitIdentity | null }>();

/**
 * Read the host's Git identity: the repository's own setting first (when a
 * repository is named), then the user's global configuration. Results are
 * cached briefly because callers sit on hot paths such as credential brokering.
 */
export function readHostGitCommitIdentity(input: { repositoryDir?: string | null; env?: NodeJS.ProcessEnv } = {}): GitCommitIdentity | null {
  const env = input.env ?? process.env;
  const cacheable = input.env === undefined;
  const key = input.repositoryDir ?? "";
  const cached = cacheable ? hostIdentityCache.get(key) : undefined;
  if (cached && Date.now() - cached.at < HOST_IDENTITY_CACHE_MS) return cached.identity;
  let identity: GitCommitIdentity | null = null;
  try {
    identity = hostGitIdentityReader({ repositoryDir: input.repositoryDir ?? null, env });
  } catch {
    identity = null;
  }
  if (cacheable) hostIdentityCache.set(key, { at: Date.now(), identity });
  return identity;
}

/** Test seam: replace the host Git reader. Returns a function that restores the default. */
export function setHostGitIdentityReaderForTests(reader: HostGitIdentityReader | null): () => void {
  const previous = hostGitIdentityReader;
  hostGitIdentityReader = reader ?? defaultHostGitIdentityReader;
  hostIdentityCache.clear();
  return () => {
    hostGitIdentityReader = previous;
    hostIdentityCache.clear();
  };
}

/** Resolve the operator's commit identity for this host, optionally for one repository and GitHub account. */
export function resolveOperatorGitCommitIdentity(input: {
  repositoryDir?: string | null;
  github?: { login?: string | null; userId?: string | number | null } | null;
  env?: NodeJS.ProcessEnv;
} = {}): GitCommitIdentity {
  const env = input.env ?? process.env;
  return resolveGitCommitIdentity({
    explicit: readExplicitGitCommitIdentity(env),
    hostGitConfig: readHostGitCommitIdentity({ repositoryDir: input.repositoryDir, env: input.env }),
    github: githubNoreplyIdentity(input.github),
  });
}

/** `git -c` arguments naming an identity for one invocation. */
export function gitCommitIdentityConfigArgs(identity: Pick<GitCommitIdentity, "name" | "email">): string[] {
  return ["-c", `user.name=${identity.name}`, "-c", `user.email=${identity.email}`];
}
