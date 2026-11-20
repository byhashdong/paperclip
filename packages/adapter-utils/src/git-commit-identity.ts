import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Who Paperclip names as author and committer on the commits it makes or brokers.
 *
 * Commits belong to the operator's developer identity, never to Paperclip or an
 * agent, and that identity can differ per project (for example a work identity
 * for one organization's repositories and a personal one for everything else).
 * Git picks the identity per repository, highest first:
 *
 *   1. the repository's own `user.name`/`user.email`,
 *   2. the operator's identity map (`PAPERCLIP_GIT_COMMIT_IDENTITIES`), matched
 *      by the repository's GitHub owner or `owner/repo` the way the GitHub
 *      connections' "Responsible GitHub owners" are,
 *   3. the host user's real global Git configuration, including its `include`
 *      and `includeIf` rules,
 *   4. the operator's default identity (`PAPERCLIP_GIT_DEFAULT_COMMIT_NAME` and
 *      `PAPERCLIP_GIT_DEFAULT_COMMIT_EMAIL`),
 *   5. Paperclip, only so that Git does not refuse to commit with no identity.
 *
 * Paperclip runs Git with a scratch global configuration (so the host's
 * credential helpers and gh authentication never apply). That scratch
 * configuration is generated here and expresses levels 2 to 5 in Git's own
 * terms, so Git itself evaluates them per repository and the repository's
 * own setting (level 1) still wins. Only identity keys are ever copied from
 * the host configuration: `user.name`, `user.email` and the include structure
 * that leads to them. Credentials, credential helpers, URL rewrites and every
 * other setting stay behind.
 */
export type GitCommitIdentity = { name: string; email: string };

export const GIT_COMMIT_IDENTITIES_ENV = "PAPERCLIP_GIT_COMMIT_IDENTITIES";
export const GIT_DEFAULT_COMMIT_NAME_ENV = "PAPERCLIP_GIT_DEFAULT_COMMIT_NAME";
export const GIT_DEFAULT_COMMIT_EMAIL_ENV = "PAPERCLIP_GIT_DEFAULT_COMMIT_EMAIL";

export const PAPERCLIP_FALLBACK_GIT_IDENTITY: GitCommitIdentity = Object.freeze({
  name: "Paperclip",
  email: "noreply@paperclip.ing",
});

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

function completeIdentity(name: unknown, email: unknown): GitCommitIdentity | null {
  const cleanName = cleanIdentityValue(name);
  const cleanEmail = cleanIdentityValue(email);
  return cleanName && cleanEmail ? { name: cleanName, email: cleanEmail } : null;
}

export function readDefaultGitCommitIdentity(env: NodeJS.ProcessEnv = process.env): GitCommitIdentity | null {
  return completeIdentity(env[GIT_DEFAULT_COMMIT_NAME_ENV], env[GIT_DEFAULT_COMMIT_EMAIL_ENV]);
}

// ---------------------------------------------------------------------------
// Operator identity map

/** One entry of the identity map: the identity for a set of owners and repositories. */
export type GitCommitIdentityRule = {
  /** Lower-cased GitHub owners (users or organizations). */
  owners: string[];
  /** Lower-cased `owner/repo` names. */
  repositories: string[];
  identity: GitCommitIdentity;
};

// Same owner syntax as the GitHub connections' "Responsible GitHub owners".
const OWNER_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38})$/;
const REPOSITORY_PATTERN = /^[a-z0-9_.-]{1,100}$/;

function parseMatchEntries(value: unknown): { owners: string[]; repositories: string[] } {
  const entries = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[\s,;]+/) : [];
  const owners = new Set<string>();
  const repositories = new Set<string>();
  for (const entry of entries) {
    if (typeof entry !== "string") continue;
    const normalized = entry.trim().replace(/^@/, "").replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, "")
      .replace(/\.git$/i, "").replace(/\/+$/, "").toLowerCase();
    const [owner, repository, extra] = normalized.split("/");
    if (!owner || !OWNER_PATTERN.test(owner) || extra !== undefined) continue;
    if (repository === undefined) owners.add(owner);
    else if (REPOSITORY_PATTERN.test(repository) && repository !== "." && repository !== "..") repositories.add(`${owner}/${repository}`);
  }
  return { owners: [...owners], repositories: [...repositories] };
}

let warnedInvalidIdentityMap = false;

/**
 * Parse `PAPERCLIP_GIT_COMMIT_IDENTITIES`: a JSON array of
 * `{ "match": "owner other-owner owner/repo", "name": "...", "email": "..." }`.
 * `match` is a comma/whitespace separated list (or an array) of GitHub owners
 * and `owner/repo` names. Invalid entries are skipped.
 */
export function parseGitCommitIdentityRules(value: unknown): GitCommitIdentityRule[] {
  if (value === undefined || value === null || (typeof value === "string" && !value.trim())) return [];
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = null;
    }
  }
  if (!Array.isArray(parsed)) {
    if (!warnedInvalidIdentityMap) {
      warnedInvalidIdentityMap = true;
      process.emitWarning(`${GIT_COMMIT_IDENTITIES_ENV} must be a JSON array of {match, name, email}; it is ignored.`);
    }
    return [];
  }
  const rules: GitCommitIdentityRule[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const identity = completeIdentity(record.name, record.email);
    const { owners, repositories } = parseMatchEntries(record.match ?? record.owners);
    if (identity && (owners.length > 0 || repositories.length > 0)) rules.push({ owners, repositories, identity });
  }
  return rules;
}

// URL forms Git remotes use for github.com. The GitHub owner routing accepts
// the same forms (https, http, ssh, git and scp-style, with or without www).
const GITHUB_REMOTE_PREFIXES = [
  "https://github.com/", "https://www.github.com/", "http://github.com/", "http://www.github.com/",
  "ssh://git@github.com/", "ssh://git@www.github.com/", "git://github.com/",
  "git@github.com:", "git@www.github.com:", "git@github.com:/",
];

/** A glob that matches `value` regardless of letter case (GitHub names are case-insensitive). */
function caseInsensitiveGlob(value: string): string {
  return value.replace(/[a-z]/g, (letter) => `[${letter}${letter.toUpperCase()}]`);
}

function remoteUrlPatternsForOwner(owner: string): string[] {
  return GITHUB_REMOTE_PREFIXES.map((prefix) => `${prefix}${caseInsensitiveGlob(owner)}/**`);
}

function remoteUrlPatternsForRepository(fullName: string): string[] {
  const glob = caseInsensitiveGlob(fullName);
  return GITHUB_REMOTE_PREFIXES.flatMap((prefix) => [`${prefix}${glob}`, `${prefix}${glob}.git`, `${prefix}${glob}/`]);
}

// ---------------------------------------------------------------------------
// Host Git configuration (identity keys only)

/**
 * The host user's global Git configuration files, in Git's order (later files
 * win). Paperclip's server often runs with a private `HOME`, so the operating
 * system account's home directory is used when it has a Git configuration; an
 * explicit, non-scratch `GIT_CONFIG_GLOBAL` names the file directly.
 */
export function hostGitConfigFiles(env: NodeJS.ProcessEnv = process.env): { files: string[]; home: string } {
  if (hostGitConfigFilesOverride) return hostGitConfigFilesOverride;
  const accountHome = (() => {
    try { return os.userInfo().homedir; } catch { return ""; }
  })();
  const envHome = env.HOME?.trim() || "";
  const configured = env.GIT_CONFIG_GLOBAL?.trim();
  if (configured) {
    const scratch = configured === "/dev/null" || configured === os.devNull || configured.includes("paperclip-github-operation-")
      || configured.includes("paperclip-git-identity-");
    if (!scratch && fs.existsSync(configured)) return { files: [configured], home: envHome || accountHome };
  }
  const filesFor = (home: string, xdg: string) => [xdg ? path.join(xdg, "git", "config") : "", home ? path.join(home, ".gitconfig") : ""]
    .filter((file) => file && fs.existsSync(file));
  if (accountHome) {
    const files = filesFor(accountHome, path.join(accountHome, ".config"));
    if (files.length > 0) return { files, home: accountHome };
  }
  if (envHome && envHome !== accountHome) {
    const files = filesFor(envHome, env.XDG_CONFIG_HOME?.trim() || path.join(envHome, ".config"));
    if (files.length > 0) return { files, home: envHome };
  }
  return { files: [], home: accountHome || envHome };
}

let hostGitConfigFilesOverride: { files: string[]; home: string } | null = null;

type HostEntry =
  | { kind: "user"; key: "name" | "email"; value: string }
  | { kind: "include"; condition: string | null; target: number };

type HostMirror = { entries: HostEntry[][]; top: HostEntry[] };

/**
 * Environment for Paperclip's own identity lookups: no inherited Git
 * overrides, and the real Git binary rather than a Paperclip GitHub launcher
 * (which would substitute its own scratch configuration).
 */
function plainGitEnv(globalConfig: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("GIT_") && value !== undefined) env[key] = value;
  const launcherDir = process.env.PAPERCLIP_GITHUB_LAUNCHER_DIR?.trim();
  if (launcherDir && env.PATH) env.PATH = env.PATH.split(path.delimiter).filter((entry) => path.resolve(entry) !== path.resolve(launcherDir)).join(path.delimiter);
  delete env.PAPERCLIP_GITHUB_LAUNCHER_DIR;
  return Object.assign(env, {
    GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_SYSTEM: os.devNull, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "0", GIT_TERMINAL_PROMPT: "0",
  });
}

/** Identity-relevant entries of one config file, in file order, without following includes. */
function readIdentityEntries(file: string): Array<{ key: string; value: string }> {
  const env = plainGitEnv(os.devNull);
  try {
    const result = spawnSync("git", [
      "config", "--file", file, "--no-includes", "-z", "--get-regexp", "^(user\\.(name|email)|include\\.path|includeif\\..+\\.path)$",
    ], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"], env });
    if (result.status !== 0) return [];
    return String(result.stdout).split("\0").filter(Boolean).flatMap((record) => {
      const newline = record.indexOf("\n");
      return newline < 0 ? [] : [{ key: record.slice(0, newline), value: record.slice(newline + 1) }];
    });
  } catch {
    return [];
  }
}

function expandHome(value: string, home: string): string | null {
  if (value === "~" || value.startsWith("~/")) return home ? home.replace(/\/+$/, "") + value.slice(1) : null;
  if (value.startsWith("~")) return null; // ~otheruser is not supported
  return value;
}

/**
 * Make an includeIf condition independent of where the scratch file lives.
 * Returns every condition to emit (none when Git could not evaluate it here).
 *
 * Git matches `gitdir:` against the repository's real path, and against the
 * unresolved one only when `$PWD` names it, which a spawned process often
 * lacks. When the pattern's fixed directory goes through a symlink, its real
 * path is emitted as well so the rule matches either way.
 */
function portableConditions(condition: string, file: string, home: string): string[] {
  const gitdir = /^(gitdir(?:\/i)?:)(.*)$/su.exec(condition);
  if (!gitdir) return [condition];
  const pattern = gitdir[2];
  const expanded = pattern.startsWith("./") ? path.dirname(file) + pattern.slice(1) : expandHome(pattern, home);
  if (expanded === null) return [];
  const conditions = [gitdir[1] + expanded];
  if (path.isAbsolute(expanded)) {
    const glob = expanded.search(/[*?[\\]/u);
    const fixed = glob < 0 ? expanded : expanded.slice(0, glob);
    const directory = fixed.endsWith("/") ? fixed.slice(0, -1) : path.dirname(fixed);
    try {
      const real = fs.realpathSync(directory || "/");
      if (real !== directory) conditions.push(gitdir[1] + real + expanded.slice(directory.length));
    } catch {
      // A directory that does not exist yet cannot go through a symlink.
    }
  }
  return conditions;
}

const MAX_INCLUDE_DEPTH = 10;

function mirrorHostConfig(files: string[], home: string): HostMirror {
  const mirror: HostMirror = { entries: [], top: [] };
  const indexByFile = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (file: string, depth: number): HostEntry[] => {
    const out: HostEntry[] = [];
    for (const { key, value } of readIdentityEntries(file)) {
      if (key === "user.name" || key === "user.email") {
        const clean = cleanIdentityValue(value);
        if (clean) out.push({ kind: "user", key: key === "user.name" ? "name" : "email", value: clean });
        continue;
      }
      const conditional = /^includeif\.(.+)\.path$/su.exec(key);
      const conditions: Array<string | null> = conditional ? portableConditions(conditional[1], file, home) : [null];
      if (conditions.length === 0 || depth >= MAX_INCLUDE_DEPTH) continue;
      const expanded = expandHome(value, home);
      if (!expanded) continue;
      const target = path.resolve(path.dirname(file), expanded);
      let real: string;
      try { real = fs.realpathSync(target); } catch { continue; } // Git ignores missing include files too.
      if (visiting.has(real)) continue; // a cycle would make Git fail with "exceeded maximum include depth"
      let index = indexByFile.get(real);
      if (index === undefined) {
        visiting.add(real);
        const entries = visit(real, depth + 1);
        visiting.delete(real);
        index = mirror.entries.length;
        mirror.entries.push(entries);
        indexByFile.set(real, index);
      }
      for (const condition of conditions) out.push({ kind: "include", condition, target: index });
    }
    return out;
  };
  for (const file of files) {
    let real: string;
    try { real = fs.realpathSync(file); } catch { continue; }
    visiting.add(real);
    mirror.top.push(...visit(real, 1));
    visiting.delete(real);
  }
  return mirror;
}

// ---------------------------------------------------------------------------
// Scratch configuration

/**
 * A self-contained global Git configuration: `gitconfig` plus the files it
 * includes, all named relative to the directory they are written to.
 */
export type GitIdentityConfig = { gitconfig: string; files: Record<string, string> };

export const IDENTITY_FILE_PATTERN = /^identity-[0-9]{1,4}$/;

/** Quote a config value so comment characters, quotes and backslashes stay part of it. */
export function gitConfigValue(value: string): string {
  if (/[\u0000-\u001f\u007f]/u.test(value)) throw new Error("Git configuration value must not contain control characters");
  if (/^[A-Za-z0-9._@+/~:-](?:[A-Za-z0-9 ._@+/~:-]*[A-Za-z0-9._@+/~:-])?$/u.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function gitConfigSubsection(value: string): string {
  if (/[\u0000-\u001f\u007f]/u.test(value)) throw new Error("Git configuration subsection must not contain control characters");
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function userSection(identity: Partial<GitCommitIdentity>): string {
  return `[user]\n${identity.name !== undefined ? `\tname = ${gitConfigValue(identity.name)}\n` : ""}`
    + `${identity.email !== undefined ? `\temail = ${gitConfigValue(identity.email)}\n` : ""}`;
}

function includeSection(condition: string | null, file: string): string {
  return `${condition === null ? "[include]" : `[includeIf ${gitConfigSubsection(condition)}]`}\n\tpath = ${file}\n`;
}

/** Assemble the scratch configuration for the given identity sources. */
export function buildGitIdentityConfig(input: {
  rules?: GitCommitIdentityRule[];
  defaultIdentity?: GitCommitIdentity | null;
  hostConfigFiles?: string[];
  hostHome?: string;
} = {}): GitIdentityConfig {
  const files: Record<string, string> = {};
  let next = 1;
  const fileName = () => `identity-${next++}`;
  // Later entries win in Git, so the lowest level comes first.
  let gitconfig = userSection(PAPERCLIP_FALLBACK_GIT_IDENTITY);
  if (input.defaultIdentity) gitconfig += userSection(input.defaultIdentity);

  const host = mirrorHostConfig(input.hostConfigFiles ?? [], input.hostHome ?? "");
  const hostNames = host.entries.map(() => fileName());
  const render = (entries: HostEntry[]) => entries.map((entry) => entry.kind === "user"
    ? userSection({ [entry.key]: entry.value })
    : includeSection(entry.condition, hostNames[entry.target]!)).join("");
  host.entries.forEach((entries, index) => { files[hostNames[index]!] = render(entries); });
  gitconfig += render(host.top);

  const rules = input.rules ?? [];
  const ruleNames = rules.map((rule) => {
    const name = fileName();
    files[name] = userSection(rule.identity);
    return name;
  });
  // A repository entry is more specific than an owner entry, so it comes last.
  rules.forEach((rule, index) => {
    for (const owner of rule.owners) {
      for (const pattern of remoteUrlPatternsForOwner(owner)) gitconfig += includeSection(`hasconfig:remote.*.url:${pattern}`, ruleNames[index]!);
    }
  });
  rules.forEach((rule, index) => {
    for (const repository of rule.repositories) {
      for (const pattern of remoteUrlPatternsForRepository(repository)) gitconfig += includeSection(`hasconfig:remote.*.url:${pattern}`, ruleNames[index]!);
    }
  });
  return { gitconfig, files };
}

/** The configuration that names nothing but Paperclip's placeholder. */
export const PAPERCLIP_FALLBACK_GIT_IDENTITY_CONFIG: GitIdentityConfig = Object.freeze({
  gitconfig: userSection(PAPERCLIP_FALLBACK_GIT_IDENTITY),
  files: Object.freeze({}) as Record<string, string>,
});

const IDENTITY_CONFIG_CACHE_MS = 30_000;
let identityConfigCache: { key: string; at: number; config: GitIdentityConfig } | null = null;

/** The operator's scratch identity configuration for this host. Cached briefly. */
export function operatorGitIdentityConfig(env: NodeJS.ProcessEnv = process.env): GitIdentityConfig {
  const host = hostGitConfigFiles(env);
  const key = JSON.stringify([env[GIT_COMMIT_IDENTITIES_ENV] ?? "", env[GIT_DEFAULT_COMMIT_NAME_ENV] ?? "",
    env[GIT_DEFAULT_COMMIT_EMAIL_ENV] ?? "", host.files, host.home]);
  if (identityConfigCache && identityConfigCache.key === key && Date.now() - identityConfigCache.at < IDENTITY_CONFIG_CACHE_MS) {
    return identityConfigCache.config;
  }
  let config: GitIdentityConfig;
  try {
    config = buildGitIdentityConfig({
      rules: parseGitCommitIdentityRules(env[GIT_COMMIT_IDENTITIES_ENV]),
      defaultIdentity: readDefaultGitCommitIdentity(env),
      hostConfigFiles: host.files,
      hostHome: host.home,
    });
  } catch {
    config = PAPERCLIP_FALLBACK_GIT_IDENTITY_CONFIG;
  }
  identityConfigCache = { key, at: Date.now(), config };
  return config;
}

/** Write a scratch identity configuration into `directory`; returns the `gitconfig` path. */
export function writeGitIdentityConfig(directory: string, config: GitIdentityConfig): string {
  for (const [name, body] of Object.entries(config.files)) {
    if (!IDENTITY_FILE_PATTERN.test(name)) throw new Error("Invalid Git identity file name");
    fs.writeFileSync(path.join(directory, name), body, { mode: 0o600 });
  }
  const file = path.join(directory, "gitconfig");
  fs.writeFileSync(file, config.gitconfig, { mode: 0o600 });
  return file;
}

function materializedIdentityConfig(config: GitIdentityConfig): string | null {
  const digest = createHash("sha256").update(JSON.stringify(config)).digest("hex").slice(0, 24);
  const directory = path.join(os.tmpdir(), `paperclip-git-identity-${process.getuid?.() ?? "u"}-${digest}`);
  const file = path.join(directory, "gitconfig");
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    // The directory sits in a shared temporary directory: use it only when it
    // is this user's own private directory, not a planted link or folder.
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) return null;
    if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === config.gitconfig
      && Object.entries(config.files).every(([name, body]) => {
        try { return fs.readFileSync(path.join(directory, name), "utf8") === body; } catch { return false; }
      })) return file;
    return writeGitIdentityConfig(directory, config);
  } catch {
    return null;
  }
}

/**
 * The identity Git uses for a commit in `repositoryDir` under the operator's
 * identity configuration: the repository's own setting first, then the
 * identity map, the host configuration, the default identity and Paperclip.
 */
export function resolveRepositoryGitCommitIdentity(repositoryDir: string, env: NodeJS.ProcessEnv = process.env): GitCommitIdentity {
  const config = operatorGitIdentityConfig(env);
  const globalFile = materializedIdentityConfig(config);
  if (!globalFile) return readDefaultGitCommitIdentity(env) ?? PAPERCLIP_FALLBACK_GIT_IDENTITY;
  const gitEnv = plainGitEnv(globalFile);
  const read = (key: string) => {
    try {
      const result = spawnSync("git", ["-C", repositoryDir, "config", "--get", key], {
        encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"], env: gitEnv,
      });
      return result.status === 0 ? String(result.stdout).trim() : null;
    } catch {
      return null;
    }
  };
  return completeIdentity(read("user.name"), read("user.email")) ?? readDefaultGitCommitIdentity(env) ?? PAPERCLIP_FALLBACK_GIT_IDENTITY;
}

/** `git -c` arguments naming an identity for one invocation. */
export function gitCommitIdentityConfigArgs(identity: GitCommitIdentity): string[] {
  return ["-c", `user.name=${identity.name}`, "-c", `user.email=${identity.email}`];
}

/** Test seam: pin the host Git configuration files (`[]` for none). Returns a restore function. */
export function setHostGitConfigFilesForTests(value: { files: string[]; home?: string } | null): () => void {
  const previous = hostGitConfigFilesOverride;
  hostGitConfigFilesOverride = value ? { files: value.files, home: value.home ?? "" } : null;
  identityConfigCache = null;
  return () => {
    hostGitConfigFilesOverride = previous;
    identityConfigCache = null;
  };
}
