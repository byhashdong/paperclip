import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  githubNoreplyIdentity,
  isPaperclipPlaceholderIdentity,
  PAPERCLIP_FALLBACK_GIT_IDENTITY,
  readExplicitGitCommitIdentity,
  readHostGitCommitIdentity,
  resolveGitCommitIdentity,
  resolveOperatorGitCommitIdentity,
  setHostGitIdentityReaderForTests,
  type GitCommitIdentity,
} from "./git-commit-identity.js";
import { githubBrokerEnvironment, githubLauncherGitConfig, githubLauncherSource } from "./github-launcher.js";
import { gitSyncCommitIdentityArgs } from "./git-workspace-sync.js";

const exec = promisify(execFile);
const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function tempDir(prefix: string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function useHostIdentity(identity: GitCommitIdentity | null) {
  cleanups.push(setHostGitIdentityReaderForTests(() => identity));
}

const explicit: GitCommitIdentity = { name: "Operator", email: "operator@example.test", source: "explicit" };
const host: GitCommitIdentity = { name: "Host Dev", email: "host@example.test", source: "host_git_config" };
const github = githubNoreplyIdentity({ login: "byhashdong", userId: "88993803" });

describe("commit identity order", () => {
  it("prefers explicit configuration, then host Git, then the GitHub account, then Paperclip", () => {
    expect(resolveGitCommitIdentity({ explicit, hostGitConfig: host, github })).toBe(explicit);
    expect(resolveGitCommitIdentity({ explicit: null, hostGitConfig: host, github })).toBe(host);
    expect(resolveGitCommitIdentity({ explicit: null, hostGitConfig: null, github })).toBe(github);
    expect(resolveGitCommitIdentity({})).toEqual(PAPERCLIP_FALLBACK_GIT_IDENTITY);
  });

  it("derives GitHub's noreply address from the connected account", () => {
    expect(github).toEqual({
      name: "byhashdong", email: "88993803+byhashdong@users.noreply.github.com", source: "github_connection",
    });
    expect(githubNoreplyIdentity({ login: "octocat" })?.email).toBe("octocat@users.noreply.github.com");
    expect(githubLauncherGitConfig()).toBe("[user]\n\tname = Paperclip\n\temail = noreply@paperclip.ing\n");
    expect(githubNoreplyIdentity({ login: "bad login" })).toBeNull();
    expect(githubNoreplyIdentity(null)).toBeNull();
  });

  it("reads explicit configuration only when both values are usable", () => {
    expect(readExplicitGitCommitIdentity({ PAPERCLIP_GIT_COMMIT_NAME: " Operator ", PAPERCLIP_GIT_COMMIT_EMAIL: "operator@example.test" }))
      .toEqual(explicit);
    expect(readExplicitGitCommitIdentity({ PAPERCLIP_GIT_COMMIT_NAME: "Operator" })).toBeNull();
    expect(readExplicitGitCommitIdentity({ PAPERCLIP_GIT_COMMIT_NAME: "Op\nerator", PAPERCLIP_GIT_COMMIT_EMAIL: "o@example.test" })).toBeNull();
    expect(readExplicitGitCommitIdentity({ PAPERCLIP_GIT_COMMIT_NAME: "Op", PAPERCLIP_GIT_COMMIT_EMAIL: "<o@example.test>" })).toBeNull();
    // Re-stating Paperclip's placeholder is not a developer identity.
    expect(readExplicitGitCommitIdentity({ PAPERCLIP_GIT_COMMIT_NAME: "Paperclip", PAPERCLIP_GIT_COMMIT_EMAIL: "noreply@paperclip.ing" })).toBeNull();
    expect(isPaperclipPlaceholderIdentity({ name: "Paperclip", email: "workspace@paperclip.invalid" })).toBe(true);
  });

  it("applies the order to the operator identity", () => {
    const env = { PAPERCLIP_GIT_COMMIT_NAME: "Operator", PAPERCLIP_GIT_COMMIT_EMAIL: "operator@example.test" };
    useHostIdentity(host);
    expect(resolveOperatorGitCommitIdentity({ env, github: { login: "byhashdong", userId: 88993803 } })).toEqual(explicit);
    expect(resolveOperatorGitCommitIdentity({ env: {}, github: { login: "byhashdong", userId: 88993803 } })).toEqual(host);
    useHostIdentity(null);
    expect(resolveOperatorGitCommitIdentity({ env: {}, github: { login: "byhashdong", userId: 88993803 } })).toEqual(github);
    expect(resolveOperatorGitCommitIdentity({ env: {} })).toEqual(PAPERCLIP_FALLBACK_GIT_IDENTITY);
  });
});

describe("host Git identity", () => {
  it("reads the user's global configuration and lets a repository's own setting win", async () => {
    const home = await tempDir("paperclip-identity-home-");
    await writeFile(path.join(home, ".gitconfig"), "[user]\n\tname = Global Dev\n\temail = global@example.test\n");
    const env = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config") };
    expect(readHostGitCommitIdentity({ env })).toEqual({ name: "Global Dev", email: "global@example.test", source: "host_git_config" });

    const repo = path.join(home, "repo");
    await exec("git", ["init", "-q", repo], { env });
    expect(readHostGitCommitIdentity({ repositoryDir: repo, env })?.name).toBe("Global Dev");
    await exec("git", ["-C", repo, "config", "user.name", "Repo Dev"], { env });
    await exec("git", ["-C", repo, "config", "user.email", "repo@example.test"], { env });
    expect(readHostGitCommitIdentity({ repositoryDir: repo, env })).toEqual({ name: "Repo Dev", email: "repo@example.test", source: "host_git_config" });
  });

  it("ignores a launcher's scratch configuration and Paperclip's placeholder", async () => {
    const home = await tempDir("paperclip-identity-scratch-");
    const scratch = path.join(home, "paperclip-github-operation-abc");
    await mkdir(scratch);
    await writeFile(path.join(scratch, "gitconfig"), "[user]\n\tname = Someone\n\temail = someone@example.test\n");
    await writeFile(path.join(home, ".gitconfig"), githubLauncherGitConfig());
    expect(readHostGitCommitIdentity({ env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_GLOBAL: path.join(scratch, "gitconfig") } })).toBeNull();
    expect(readHostGitCommitIdentity({ env: { PATH: process.env.PATH, HOME: home } })).toBeNull();
    expect(readHostGitCommitIdentity({ env: { PATH: process.env.PATH, HOME: path.join(home, "missing") } })).toBeNull();
  });

  it("gives sync merge commits the repository's developer identity", async () => {
    useHostIdentity(null);
    expect(gitSyncCommitIdentityArgs()).toEqual(["-c", "user.name=Paperclip", "-c", "user.email=noreply@paperclip.ing"]);
    useHostIdentity(host);
    expect(gitSyncCommitIdentityArgs("/repo")).toEqual(["-c", "user.name=Host Dev", "-c", "user.email=host@example.test"]);
  });
});

describe("GitHub launcher commit identity", () => {
  async function launcherRepo(options: { commitIdentity?: GitCommitIdentity; brokerIdentity?: { name: string; email: string } }) {
    const root = await tempDir("paperclip-launcher-identity-");
    const bin = path.join(root, "managed");
    await mkdir(bin);
    await exec("git", ["init", "-q", root]);
    await writeFile(path.join(bin, "git"), githubLauncherSource({ commitIdentity: options.commitIdentity }), { mode: 0o700 });
    let url = "", token = "";
    if (options.brokerIdentity) {
      const { name, email } = options.brokerIdentity;
      const server = createServer((_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ status: "available", env: {
          GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email,
        } }));
      });
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
      url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      token = "run-capability";
    }
    const env = { ...process.env, ...githubBrokerEnvironment({}, { url, token }), PATH: `${bin}:${process.env.PATH}` };
    const commit = async () => {
      await exec(path.join(bin, "git"), ["commit", "--allow-empty", "-q", "-m", "Work"], { cwd: root, env });
      return (await exec("git", ["-C", root, "log", "-1", "--format=%an <%ae>|%cn <%ce>"])).stdout.trim();
    };
    return { root, commit };
  }

  it("names the host developer instead of Paperclip when no account identity is brokered", async () => {
    const { commit } = await launcherRepo({ commitIdentity: host });
    expect(await commit()).toBe("Host Dev <host@example.test>|Host Dev <host@example.test>");
  });

  it("uses the brokered account identity over the scratch configuration", async () => {
    const { commit } = await launcherRepo({ brokerIdentity: { name: "byhashdong", email: "88993803+byhashdong@users.noreply.github.com" } });
    expect(await commit()).toBe("byhashdong <88993803+byhashdong@users.noreply.github.com>|byhashdong <88993803+byhashdong@users.noreply.github.com>");
  });

  it("keeps a repository's own identity over the host's", async () => {
    const { root, commit } = await launcherRepo({ commitIdentity: host });
    await exec("git", ["-C", root, "config", "user.name", "Repo Dev"]);
    await exec("git", ["-C", root, "config", "user.email", "repo@example.test"]);
    expect(await commit()).toBe("Repo Dev <repo@example.test>|Repo Dev <repo@example.test>");
  });

  it("pins an explicitly configured identity over repository and account identities", async () => {
    const { root, commit } = await launcherRepo({ commitIdentity: explicit, brokerIdentity: { name: "Account", email: "account@example.test" } });
    await exec("git", ["-C", root, "config", "user.name", "Repo Dev"]);
    await exec("git", ["-C", root, "config", "user.email", "repo@example.test"]);
    expect(await commit()).toBe("Operator <operator@example.test>|Operator <operator@example.test>");
  });

  it("quotes identity values so they cannot add configuration", () => {
    expect(githubLauncherGitConfig({ name: 'A "B" \\ C', email: "a@example.test" }))
      .toBe('[user]\n\tname = "A \\"B\\" \\\\ C"\n\temail = a@example.test\n');
    expect(githubLauncherGitConfig({ name: "A ; B", email: "a#b@example.test" }))
      .toBe('[user]\n\tname = "A ; B"\n\temail = "a#b@example.test"\n');
    expect(() => githubLauncherGitConfig({ name: "A\n[core]", email: "a@example.test" })).toThrow("control characters");
    expect(githubLauncherSource({ commitIdentity: { ...PAPERCLIP_FALLBACK_GIT_IDENTITY, source: "explicit" } }))
      .toBe(githubLauncherSource());
  });
});
