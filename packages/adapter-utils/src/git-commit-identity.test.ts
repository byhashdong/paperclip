import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildGitIdentityConfig,
  gitConfigValue,
  operatorGitIdentityConfig,
  PAPERCLIP_FALLBACK_GIT_IDENTITY_CONFIG,
  parseGitCommitIdentityRules,
  readDefaultGitCommitIdentity,
  resolveRepositoryGitCommitIdentity,
  setHostGitConfigFilesForTests,
  type GitIdentityConfig,
} from "./git-commit-identity.js";
import { githubBrokerEnvironment, githubLauncherSource } from "./github-launcher.js";
import { gitSyncCommitIdentityArgs } from "./git-workspace-sync.js";

const exec = promisify(execFile);
const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function tempDir(prefix: string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const SENTINAN = "terry <terry@sentinan.com>";
const PERSONAL = "byhashdong <byhashdong@protonmail.com>";

/**
 * A host configuration shaped like the operator's: a personal default, a
 * work identity included by folder and by remote URL, and credential helpers
 * that must never reach Paperclip's scratch configuration.
 */
async function operatorHost() {
  const home = await tempDir("paperclip-identity-host-");
  const work = path.join(home, "Work", "Sentinan");
  await mkdir(work, { recursive: true });
  await writeFile(path.join(home, ".gitconfig-sentinan"), "[user]\n\tname = terry\n\temail = terry@sentinan.com\n[credential]\n\thelper = store-work\n");
  const remotes = [
    "git@github-sentinan:*/**",
    "https://github.com/sentinan/**", "git@github.com:sentinan/**",
    "https://github.com/terryzhao2025/**", "git@github.com:terryzhao2025/**",
    "https://github.com/byhashdong/sentinan_pages*", "git@github.com:byhashdong/sentinan_pages*",
    "https://github.com/byhashdong/digital_stethoscope*", "git@github.com:byhashdong/digital_stethoscope*",
  ];
  await writeFile(path.join(home, ".gitconfig"), [
    "[credential]", "\thelper = osxkeychain",
    "[credential \"https://github.com\"]", "\thelper = ", "\thelper = !/opt/homebrew/bin/gh auth git-credential",
    "[url \"https://evil.example/\"]", "\tinsteadOf = https://github.com/",
    "[http]", "\textraHeader = Authorization: Bearer host-secret",
    "[user]", "\tname = byhashdong", "\temail = byhashdong@protonmail.com",
    "[includeIf \"gitdir:~/Work/Sentinan/\"]", "\tpath = ~/.gitconfig-sentinan",
    ...remotes.flatMap((remote) => [`[includeIf "hasconfig:remote.*.url:${remote}"]`, "\tpath = .gitconfig-sentinan"]),
    "",
  ].join("\n"));
  return { home, work, files: [path.join(home, ".gitconfig")] };
}

async function repository(parent: string, name: string, remote?: string) {
  const dir = path.join(parent, name);
  await exec("git", ["init", "-q", dir], { env: isolatedGitEnv() });
  if (remote) await exec("git", ["-C", dir, "remote", "add", "origin", remote], { env: isolatedGitEnv() });
  return dir;
}

function isolatedGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("GIT_")) env[key] = value;
  return { ...env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: "1" };
}

/** Commit through the GitHub launcher, as an agent's `git commit` does. */
async function launcherCommit(identityConfig: GitIdentityConfig | undefined, repo: string, options: { brokerIdentity?: string } = {}) {
  const bin = await tempDir("paperclip-identity-launcher-");
  await writeFile(path.join(bin, "git"), githubLauncherSource({ identityConfig }), { mode: 0o700 });
  let url = "", token = "";
  if (options.brokerIdentity) {
    const [name, email] = options.brokerIdentity.split(/ <|>/);
    const server = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ status: "available", env: {
        GH_TOKEN: "managed-token", GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email,
        GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: "", GIT_CONFIG_KEY_1: "core.askPass", GIT_CONFIG_VALUE_1: "",
      } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    token = "run-capability";
  }
  const env = { ...process.env, ...githubBrokerEnvironment({ GIT_AUTHOR_NAME: "Ambient", GIT_AUTHOR_EMAIL: "ambient@example.test" }, { url, token }),
    PATH: `${bin}:${process.env.PATH}` };
  await exec(path.join(bin, "git"), ["commit", "--allow-empty", "-q", "-m", "Work"], { cwd: repo, env });
  const { stdout } = await exec("git", ["-C", repo, "log", "-1", "--format=%an <%ae>|%cn <%ce>"], { env: isolatedGitEnv() });
  const [author, committer] = stdout.trim().split("|");
  expect(committer).toBe(author);
  return author;
}

describe("identity map", () => {
  it("parses owners and owner/repo entries the way Responsible GitHub owners are written", () => {
    expect(parseGitCommitIdentityRules(JSON.stringify([
      { match: "Sentinan, @terryzhao2025 byhashdong/Sentinan_Pages https://github.com/byhashdong/digital_stethoscope.git bad/owner/x", name: "terry", email: "terry@sentinan.com" },
      { match: ["ronfi"], name: "No Email" },
      { match: "", name: "x", email: "x@example.test" },
      { match: "octo", name: "Bad <name>", email: "a@example.test" },
    ]))).toEqual([{
      owners: ["sentinan", "terryzhao2025"],
      repositories: ["byhashdong/sentinan_pages", "byhashdong/digital_stethoscope"],
      identity: { name: "terry", email: "terry@sentinan.com" },
    }]);
    expect(parseGitCommitIdentityRules(undefined)).toEqual([]);
    expect(parseGitCommitIdentityRules("not json")).toEqual([]);
  });

  it("reads the default identity only when both values are usable", () => {
    expect(readDefaultGitCommitIdentity({ PAPERCLIP_GIT_DEFAULT_COMMIT_NAME: " byhashdong ", PAPERCLIP_GIT_DEFAULT_COMMIT_EMAIL: "byhashdong@protonmail.com" }))
      .toEqual({ name: "byhashdong", email: "byhashdong@protonmail.com" });
    expect(readDefaultGitCommitIdentity({ PAPERCLIP_GIT_DEFAULT_COMMIT_NAME: "byhashdong" })).toBeNull();
    expect(readDefaultGitCommitIdentity({ PAPERCLIP_GIT_DEFAULT_COMMIT_NAME: "a\nb", PAPERCLIP_GIT_DEFAULT_COMMIT_EMAIL: "a@example.test" })).toBeNull();
  });
});

describe("per-project commit identity through the GitHub launcher", () => {
  it("follows the host's includeIf rules for every kind of repository", async () => {
    const host = await operatorHost();
    const config = buildGitIdentityConfig({ hostConfigFiles: host.files, hostHome: host.home });
    const elsewhere = await tempDir("paperclip-identity-repos-");
    const cases: Array<[string, string | undefined, string, string?]> = [
      ["sentinan-org", "https://github.com/sentinan/website.git", SENTINAN],
      ["sentinan-org-ssh", "git@github.com:sentinan/website.git", SENTINAN],
      ["terryzhao2025", "https://github.com/terryzhao2025/tool.git", SENTINAN],
      ["sentinan-pages", "git@github.com:byhashdong/sentinan_pages.git", SENTINAN],
      ["digital-stethoscope", "https://github.com/byhashdong/digital_stethoscope", SENTINAN],
      ["ssh-alias", "git@github-sentinan:sentinan/app.git", SENTINAN],
      ["ronfi", "https://github.com/ronfi/bot.git", PERSONAL],
      ["byhashdong", "https://github.com/byhashdong/paperclip.git", PERSONAL],
      ["upstream", "https://github.com/paperclipai/paperclip.git", PERSONAL],
      ["no-remote", undefined, PERSONAL],
      ["sentinan-folder-no-remote", undefined, SENTINAN, host.work],
    ];
    for (const [name, remote, expected, parent] of cases) {
      const repo = await repository(parent ?? elsewhere, name, remote);
      expect(`${name}: ${await launcherCommit(config, repo)}`).toBe(`${name}: ${expected}`);
      expect(`${name}: ${gitSyncCommitIdentity(repo, host)}`).toBe(`${name}: ${expected}`);
    }
  });

  it("keeps a repository's own setting above everything else, and ignores brokered identities", async () => {
    const host = await operatorHost();
    const config = buildGitIdentityConfig({
      hostConfigFiles: host.files, hostHome: host.home,
      rules: parseGitCommitIdentityRules(JSON.stringify([{ match: "sentinan", name: "Mapped", email: "mapped@example.test" }])),
    });
    const repo = await repository(await tempDir("paperclip-identity-local-"), "app", "https://github.com/sentinan/app.git");
    await exec("git", ["-C", repo, "config", "user.name", "Repo Dev"], { env: isolatedGitEnv() });
    await exec("git", ["-C", repo, "config", "user.email", "repo@example.test"], { env: isolatedGitEnv() });
    expect(await launcherCommit(config, repo, { brokerIdentity: "octocat <1+octocat@users.noreply.github.com>" })).toBe("Repo Dev <repo@example.test>");
  });

  it("ranks the identity map above the host configuration and owner/repo above owner", async () => {
    const host = await operatorHost();
    const config = buildGitIdentityConfig({
      hostConfigFiles: host.files, hostHome: host.home,
      rules: parseGitCommitIdentityRules(JSON.stringify([
        { match: "byhashdong/special", name: "Special", email: "special@example.test" },
        { match: "sentinan byhashdong", name: "Mapped", email: "mapped@example.test" },
      ])),
    });
    const parent = await tempDir("paperclip-identity-map-");
    expect(await launcherCommit(config, await repository(parent, "a", "https://github.com/Sentinan/App.git"))).toBe("Mapped <mapped@example.test>");
    expect(await launcherCommit(config, await repository(parent, "b", "git@github.com:byhashdong/notes.git"))).toBe("Mapped <mapped@example.test>");
    expect(await launcherCommit(config, await repository(parent, "c", "https://github.com/byhashdong/special.git"))).toBe("Special <special@example.test>");
    expect(await launcherCommit(config, await repository(parent, "d", "https://github.com/byhashdong/special-other.git"))).toBe("Mapped <mapped@example.test>");
    expect(await launcherCommit(config, await repository(parent, "e", "https://github.com/ronfi/bot.git"))).toBe(PERSONAL);
  });

  it("uses the default identity below the host configuration, and Paperclip only when nothing is configured", async () => {
    const parent = await tempDir("paperclip-identity-default-");
    const repo = await repository(parent, "app", "https://github.com/ronfi/bot.git");
    const defaultIdentity = { name: "Default Dev", email: "default@example.test" };
    expect(await launcherCommit(buildGitIdentityConfig({ defaultIdentity }), repo)).toBe("Default Dev <default@example.test>");
    const host = await operatorHost();
    expect(await launcherCommit(buildGitIdentityConfig({ defaultIdentity, hostConfigFiles: host.files, hostHome: host.home }), repo)).toBe(PERSONAL);
    expect(await launcherCommit(undefined, repo)).toBe("Paperclip <noreply@paperclip.ing>");
    expect(await launcherCommit(buildGitIdentityConfig(), repo)).toBe("Paperclip <noreply@paperclip.ing>");
  });
});

function gitSyncCommitIdentity(repo: string, host: { files: string[]; home: string }) {
  const restore = setHostGitConfigFilesForTests(host);
  try {
    const args = gitSyncCommitIdentityArgs(repo);
    return `${args[1]!.slice("user.name=".length)} <${args[3]!.slice("user.email=".length)}>`;
  } finally {
    restore();
  }
}

describe("scratch identity configuration", () => {
  it("copies only identity keys and include structure from the host", async () => {
    const host = await operatorHost();
    const config = buildGitIdentityConfig({ hostConfigFiles: host.files, hostHome: host.home });
    const everything = [config.gitconfig, ...Object.values(config.files)].join("\n");
    for (const forbidden of ["credential", "helper", "osxkeychain", "gh auth", "insteadOf", "evil.example", "extraHeader", "host-secret", "store-work"]) {
      expect(everything).not.toContain(forbidden);
    }
    // ~ and relative include paths are pinned to the host home; included files are referenced locally.
    expect(config.gitconfig).toContain(`[includeIf "gitdir:${host.home}/Work/Sentinan/"]\n\tpath = identity-1\n`);
    expect(config.files["identity-1"]).toBe("[user]\n\tname = terry\n[user]\n\temail = terry@sentinan.com\n");
    expect(Object.keys(config.files)).toEqual(["identity-1"]);
    expect(PAPERCLIP_FALLBACK_GIT_IDENTITY_CONFIG.gitconfig).toBe("[user]\n\tname = Paperclip\n\temail = noreply@paperclip.ing\n");
  });

  it("drops include cycles instead of letting Git fail", async () => {
    const home = await tempDir("paperclip-identity-cycle-");
    await writeFile(path.join(home, ".gitconfig"), "[user]\n\tname = A\n\temail = a@example.test\n[include]\n\tpath = other\n");
    await writeFile(path.join(home, "other"), "[include]\n\tpath = .gitconfig\n[user]\n\tname = B\n");
    const config = buildGitIdentityConfig({ hostConfigFiles: [path.join(home, ".gitconfig")], hostHome: home });
    const repo = await repository(home, "repo");
    expect(await launcherCommit(config, repo)).toBe("B <a@example.test>");
  });

  it("quotes values and subsections so they cannot add configuration", () => {
    expect(gitConfigValue("byhashdong@protonmail.com")).toBe("byhashdong@protonmail.com");
    expect(gitConfigValue('A "B" \\ C')).toBe('"A \\"B\\" \\\\ C"');
    expect(gitConfigValue("A ; B #c")).toBe('"A ; B #c"');
    expect(() => gitConfigValue("A\n[core]")).toThrow("control characters");
    const config = buildGitIdentityConfig({ defaultIdentity: { name: "A ; B", email: "a#b@example.test" } });
    expect(config.gitconfig).toContain('\tname = "A ; B"\n\temail = "a#b@example.test"\n');
  });

  it("writes the launcher's identity files inside its private scratch directory", async () => {
    const host = await operatorHost();
    const config = buildGitIdentityConfig({ hostConfigFiles: host.files, hostHome: host.home });
    const scratchRoot = await tempDir("paperclip-identity-scratch-");
    const bin = await tempDir("paperclip-identity-bin-");
    const real = await tempDir("paperclip-identity-real-");
    await writeFile(path.join(bin, "git"), githubLauncherSource({ identityConfig: config }), { mode: 0o700 });
    await writeFile(path.join(real, "git"), `#!/bin/sh\nd=$(dirname "$GIT_CONFIG_GLOBAL"); ls "$d"; cat "$GIT_CONFIG_GLOBAL" > /dev/null\n`, { mode: 0o700 });
    const env = { ...process.env, ...githubBrokerEnvironment({}, { url: "", token: "" }), GH_CONFIG_DIR: scratchRoot, PATH: `${bin}:${real}:${process.env.PATH}` };
    const { stdout } = await exec(path.join(bin, "git"), ["status"], { env });
    expect(stdout.trim().split("\n").sort()).toEqual(["gitconfig", "identity-1"]);
    expect(await readdir(scratchRoot)).toEqual([]); // removed after the operation
  });

  it("reads the operator's host configuration, identity map and default from the environment", async () => {
    const host = await operatorHost();
    cleanups.push(setHostGitConfigFilesForTests(host));
    const config = operatorGitIdentityConfig({
      PAPERCLIP_GIT_COMMIT_IDENTITIES: JSON.stringify([{ match: "sentinan", name: "terry", email: "terry@sentinan.com" }]),
      PAPERCLIP_GIT_DEFAULT_COMMIT_NAME: "byhashdong", PAPERCLIP_GIT_DEFAULT_COMMIT_EMAIL: "byhashdong@protonmail.com",
    });
    expect(config.gitconfig.indexOf("byhashdong@protonmail.com")).toBeGreaterThan(config.gitconfig.indexOf("noreply@paperclip.ing"));
    expect(config.gitconfig).toContain("hasconfig:remote.*.url:https://github.com/[sS][eE][nN][tT][iI][nN][aA][nN]/**");
    const repo = await repository(await tempDir("paperclip-identity-env-"), "x", "https://github.com/sentinan/x.git");
    expect(resolveRepositoryGitCommitIdentity(repo, {
      PAPERCLIP_GIT_COMMIT_IDENTITIES: JSON.stringify([{ match: "sentinan", name: "Mapped", email: "mapped@example.test" }]),
    })).toEqual({ name: "Mapped", email: "mapped@example.test" });
    expect(await readFile(host.files[0]!, "utf8")).toContain("osxkeychain"); // the host file itself is untouched
  });
});
