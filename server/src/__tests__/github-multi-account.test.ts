import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  companySecrets,
  connectionGrants,
  createDb,
  toolConnections,
  userSecretDefinitions,
} from "@paperclipai/db";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { githubCredentialsFixture } from "./helpers/github-credentials-fixture.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { resolveGitHubOperationCredentials } from "../services/github-operation-credentials.js";
import {
  clearPersonalTokenOwnerCache,
  createGitRemoteAuthProvider,
  filterResolvedGitHubConnectionsForRun,
} from "../services/git-credentials.js";
import { runtimeConnectionIntentRoutes } from "../routes/connection-intents.js";
import { createRuntimeToolsToken } from "../runtime-tools-token.js";
import { errorHandler } from "../middleware/index.js";

// Each stored credential resolves to a value derived from its own record, so a
// test can tell exactly which account's token an operation received.
const vault = vi.hoisted(() => ({
  values: new Map<string, string>(),
  resolveUserSecretValue: vi.fn(async (_company: string, input: { definitionId: string }) => ({
    value: vault.values.get(input.definitionId) ?? `token-${input.definitionId}`,
  })),
  resolveSecretValue: vi.fn(async (_company: string, secretId: string) => vault.values.get(secretId) ?? `token-${secretId}`),
  getByName: vi.fn(async () => null),
}));
vi.mock("../services/secrets.js", () => ({ secretService: () => vault }));

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_GITHUB_CREDENTIAL_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();

(support.supported ? describe : describe.skip)("several isolated GitHub accounts in one company", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "test-github-multi-account-secret");
    if (!external) database = await startEmbeddedPostgresTestDatabase("paperclip-github-multi-account-");
    db = createDb(external ?? database!.connectionString);
  }, 30_000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await database?.cleanup();
    vi.unstubAllEnvs();
  }, 60_000);
  const { seed, grant } = githubCredentialsFixture(() => db);

  /** One person connects a personal account and a separate work account. */
  async function twoAccounts() {
    const input = await seed();
    const personal = await grant(input, "A");
    const work = await grant(input, "A");
    const tenant = (userId: string, login: string, owners: string[]) => ({
      github: {
        userId, login, installationCount: 1, repositoryCount: 1, repositorySelection: "selected" as const,
        installationIds: [userId], installationOwnerLogins: owners,
      },
    });
    await db.update(connectionGrants).set({ providerTenant: tenant("101", "byhashdong", ["byhashdong"]) })
      .where(eq(connectionGrants.id, personal.id));
    await db.update(connectionGrants).set({ providerTenant: tenant("202", "terryzhao2025", ["sentinan"]) })
      .where(eq(connectionGrants.id, work.id));
    await db.update(toolConnections).set({ createdAt: new Date("2026-01-01") }).where(eq(toolConnections.id, personal.connectionId));
    await db.update(toolConnections).set({ createdAt: new Date("2026-02-01") }).where(eq(toolConnections.id, work.connectionId));
    return {
      input, personal, work,
      personalToken: `token-${personal.definitionId}`,
      workToken: `token-${work.definitionId}`,
    };
  }
  async function setOwners(connectionId: string, githubOwners: string) {
    await db.update(toolConnections).set({ config: { sourceTemplateKey: "github", methodConfig: { githubOwners } } })
      .where(eq(toolConnections.id, connectionId));
  }
  const credentials = (input: Awaited<ReturnType<typeof seed>>, repositoryOwner?: string | null) =>
    resolveGitHubOperationCredentials(db, { ...input, repositoryOwner });

  it("routes each repository owner to its own account and never mixes tokens", async () => {
    const { input, personal, work, personalToken, workToken } = await twoAccounts();
    const forWork = await credentials(input, "Sentinan");
    expect(forWork).toMatchObject({ status: "available", login: "terryzhao2025", connectionId: work.connectionId, grantId: work.id });
    expect(forWork.env.GH_TOKEN).toBe(workToken);
    expect(JSON.stringify(forWork)).not.toContain(personalToken);

    const forPersonal = await credentials(input, "byhashdong");
    expect(forPersonal).toMatchObject({ status: "available", login: "byhashdong", connectionId: personal.connectionId });
    expect(forPersonal.env.GH_TOKEN).toBe(personalToken);
    expect(JSON.stringify(forPersonal)).not.toContain(workToken);

    const ownerless = await credentials(input);
    expect(ownerless.status).toBe("unavailable");
    expect(ownerless.reason).toMatch(/More than one GitHub account is connected/);
    expect(ownerless.env).toEqual({});

    const unknown = await credentials(input, "someone-else");
    expect(unknown.status).toBe("unavailable");
    expect(unknown.reason).toMatch(/No GitHub connection is responsible for "someone-else"/);
    expect(unknown.env).toEqual({});
  });

  it("follows each connection's Responsible GitHub owners setting", async () => {
    const { input, personal, work, workToken, personalToken } = await twoAccounts();
    await setOwners(work.connectionId, "web-biotech");
    // The work connection now handles only web-biotech, so sentinan has no account.
    expect((await credentials(input, "sentinan")).reason).toMatch(/No GitHub connection is responsible for "sentinan"/);
    expect((await credentials(input, "web-biotech")).env.GH_TOKEN).toBe(workToken);
    await setOwners(work.connectionId, "sentinan, web-biotech");
    expect((await credentials(input, "sentinan")).env.GH_TOKEN).toBe(workToken);
    expect((await credentials(input, "byhashdong")).env.GH_TOKEN).toBe(personalToken);
    // `*` makes the personal account the default for ownerless operations.
    await setOwners(personal.connectionId, "byhashdong, *");
    expect((await credentials(input)).env.GH_TOKEN).toBe(personalToken);
    expect((await credentials(input, "sentinan")).env.GH_TOKEN).toBe(workToken);
  });

  it("replaces one account's token or loses one connection without touching the other", async () => {
    const { input, personal, work, personalToken } = await twoAccounts();
    const definitionId = randomUUID(), secretId = randomUUID();
    await db.insert(userSecretDefinitions).values({ id: definitionId, companyId: input.companyId, key: definitionId, name: "Replacement" });
    await db.insert(companySecrets).values({
      id: secretId, companyId: input.companyId, key: secretId, name: `Replacement ${secretId}`,
      scope: "user", ownerUserId: "A", userSecretDefinitionId: definitionId,
    });
    await db.update(connectionGrants).set({
      credentialSecretRefs: [{ secretId, configPath: "oauth.access_token", versionSelector: "latest" }],
    }).where(eq(connectionGrants.id, work.id));
    expect((await credentials(input, "sentinan")).env.GH_TOKEN).toBe(`token-${definitionId}`);
    expect((await credentials(input, "byhashdong")).env.GH_TOKEN).toBe(personalToken);

    // A disabled work connection fails its own owners; it never borrows the personal token.
    await db.update(toolConnections).set({ enabled: false }).where(eq(toolConnections.id, work.connectionId));
    const failed = await credentials(input, "sentinan");
    expect(failed.status).toBe("unavailable");
    expect(failed.env).toEqual({});
    expect((await credentials(input, "byhashdong")).env.GH_TOKEN).toBe(personalToken);

    await db.update(toolConnections).set({ enabled: true }).where(eq(toolConnections.id, work.connectionId));
    await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, personal.id));
    expect((await credentials(input, "byhashdong")).status).toBe("unavailable");
    expect((await credentials(input, "sentinan")).env.GH_TOKEN).toBe(`token-${definitionId}`);
  });

  it("lists one set of GitHub tools for agents", async () => {
    const { input, personal, work } = await twoAccounts();
    const other = { id: randomUUID(), config: { sourceTemplateKey: "slack" } };
    const listed = await filterResolvedGitHubConnectionsForRun({
      db, companyId: input.companyId, agentId: input.agentId, responsibleUserId: "A",
      connections: [
        { id: personal.connectionId, config: { sourceTemplateKey: "github" } },
        { id: work.connectionId, config: { sourceTemplateKey: "github" } },
        other,
      ],
    });
    expect(listed.map((connection) => connection.id)).toEqual([personal.connectionId, other.id]);
  });

  it("authenticates Git remotes with the account responsible for their owner", async () => {
    const { input, personalToken, workToken } = await twoAccounts();
    const auth = createGitRemoteAuthProvider(db, input.companyId, { agentId: input.agentId, responsibleUserId: "A" }, { env: {} });
    expect((await auth("https://github.com/sentinan/ecg-reporting.git"))?.env.PAPERCLIP_GIT_TOKEN).toBe(workToken);
    expect((await auth("git@github.com:byhashdong/paperclip.git"))?.env.PAPERCLIP_GIT_TOKEN).toBe(personalToken);
    // No account handles this owner: anonymous access, not another account's token.
    expect(await auth("https://github.com/paperclipai/paperclip.git")).toBeNull();
  });

  it("uses a personal access token connection for Git and gh", async () => {
    const { input, work } = await twoAccounts();
    await db.update(toolConnections).set({
      config: { sourceTemplateKey: "github", connectionMethodKey: "mcp-key", methodConfig: { githubOwners: "sentinan, web-biotech" } },
    }).where(eq(toolConnections.id, work.connectionId));
    await db.update(connectionGrants).set({
      providerTenant: null,
      credentialSecretRefs: [{ secretId: work.secretId, configPath: "credentials.authorization", versionSelector: "latest" }],
    }).where(eq(connectionGrants.id, work.id));
    vault.values.set(work.definitionId, "Bearer github_pat_work");
    // GitHub cannot say who owns this token, so no author identity is imposed.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Bad credentials", { status: 401 })));
    clearPersonalTokenOwnerCache();
    try {
      const result = await credentials(input, "sentinan");
      expect(result).toMatchObject({ status: "available", connectionId: work.connectionId });
      expect(result.env.GH_TOKEN).toBe("github_pat_work");
      expect(result.env.GIT_AUTHOR_NAME).toBeUndefined();
      expect((await credentials(input, "byhashdong")).login).toBe("byhashdong");
    } finally {
      vi.unstubAllGlobals();
      vault.values.delete(work.definitionId);
    }
  });

  /** Both accounts connected with personal access tokens and no owners saved. */
  async function twoTokenAccounts() {
    const accounts = await twoAccounts();
    for (const account of [accounts.personal, accounts.work]) {
      await db.update(toolConnections).set({ config: { sourceTemplateKey: "github", connectionMethodKey: "mcp-key" } })
        .where(eq(toolConnections.id, account.connectionId));
      await db.update(connectionGrants).set({
        providerTenant: null,
        credentialSecretRefs: [{ secretId: account.secretId, configPath: "credentials.authorization", versionSelector: "latest" }],
      }).where(eq(connectionGrants.id, account.id));
    }
    vault.values.set(accounts.personal.definitionId, "Bearer github_pat_personal");
    vault.values.set(accounts.work.definitionId, "Bearer github_pat_work");
    // GitHub lists the repositories each token can reach.
    const reachable: Record<string, string[]> = {
      "Bearer github_pat_personal": ["byhashdong/paperclip"],
      "Bearer github_pat_work": ["sentinan/ecg-reporting", "sentinan/app_redirect_page"],
    };
    // GitHub names the account each token belongs to.
    const owners: Record<string, { id: number; login: string }> = {
      "Bearer github_pat_personal": { id: 88993803, login: "byhashdong" },
      "Bearer github_pat_work": { id: 4242, login: "sentinan-dev" },
    };
    const github = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get("authorization") ?? "";
      const names = reachable[authorization];
      if (!names) return new Response("Bad credentials", { status: 401 });
      if (String(url) === "https://api.github.com/user") return Response.json(owners[authorization]);
      return Response.json(names.map((full_name, index) => ({ id: index + 1, full_name, private: true })));
    });
    vi.stubGlobal("fetch", github);
    clearPersonalTokenOwnerCache();
    return { ...accounts, github, reachable };
  }

  it("routes personal access token connections by the owners each token can reach", async () => {
    const { input, personal, work, github, reachable } = await twoTokenAccounts();
    try {
      const forWork = await credentials(input, "sentinan");
      expect(forWork).toMatchObject({ status: "available", connectionId: work.connectionId });
      expect(forWork.env.GH_TOKEN).toBe("github_pat_work");
      const forPersonal = await credentials(input, "byhashdong");
      expect(forPersonal).toMatchObject({ status: "available", connectionId: personal.connectionId });
      expect(forPersonal.env.GH_TOKEN).toBe("github_pat_personal");
      // A token connection has no stored account, so its commits name the token's owner.
      expect(forPersonal.login).toBe("byhashdong");
      expect(forPersonal.env.GIT_AUTHOR_NAME).toBe("byhashdong");
      expect(forPersonal.env.GIT_AUTHOR_EMAIL).toBe("88993803+byhashdong@users.noreply.github.com");
      expect(forPersonal.env.GIT_COMMITTER_EMAIL).toBe("88993803+byhashdong@users.noreply.github.com");
      expect(forWork.env.GIT_AUTHOR_EMAIL).toBe("4242+sentinan-dev@users.noreply.github.com");
      // Neither token reaches this owner: refused, never borrowed.
      const unknown = await credentials(input, "octocat");
      expect(unknown.status).toBe("unavailable");
      expect(unknown.reason).toMatch(/No GitHub connection is responsible for "octocat"/);
      expect(unknown.env).toEqual({});
      // Each token is asked once; later operations reuse what it reaches.
      const lookups = github.mock.calls.length;
      // One repository lookup and one account lookup per token.
      expect(github.mock.calls.filter(([url]) => String(url) !== "https://api.github.com/user")).toHaveLength(2);
      expect(lookups).toBe(4);
      await credentials(input, "sentinan");
      expect(github.mock.calls.length).toBe(lookups);

      // A saved owner list wins over what the token reaches.
      await db.update(toolConnections).set({ config: { sourceTemplateKey: "github", connectionMethodKey: "mcp-key", methodConfig: { githubOwners: "web-biotech" } } })
        .where(eq(toolConnections.id, work.connectionId));
      expect((await credentials(input, "sentinan")).reason).toMatch(/No GitHub connection is responsible for "sentinan"/);
      await db.update(toolConnections).set({ config: { sourceTemplateKey: "github", connectionMethodKey: "mcp-key" } })
        .where(eq(toolConnections.id, work.connectionId));

      // Replacing a token looks its owners up again.
      reachable["Bearer github_pat_work_2"] = ["web-biotech/portal"];
      vault.values.set(work.definitionId, "Bearer github_pat_work_2");
      await db.update(companySecrets).set({ latestVersion: 2, updatedAt: new Date(Date.now() + 1000) })
        .where(eq(companySecrets.id, work.secretId));
      expect((await credentials(input, "web-biotech")).env.GH_TOKEN).toBe("github_pat_work_2");
      expect((await credentials(input, "sentinan")).status).toBe("unavailable");
      expect((await credentials(input, "byhashdong")).env.GH_TOKEN).toBe("github_pat_personal");
    } finally {
      vi.unstubAllGlobals();
      vault.values.delete(personal.definitionId);
      vault.values.delete(work.definitionId);
      clearPersonalTokenOwnerCache();
    }
  });

  it("claims no owners for a token GitHub rejects, without affecting the other account", async () => {
    const { input, personal, work, reachable } = await twoTokenAccounts();
    delete reachable["Bearer github_pat_work"];
    try {
      const failed = await credentials(input, "sentinan");
      expect(failed.status).toBe("unavailable");
      expect(failed.reason).toMatch(/No GitHub connection is responsible for "sentinan"/);
      expect(JSON.stringify(failed)).not.toContain("github_pat");
      expect((await credentials(input, "byhashdong")).env.GH_TOKEN).toBe("github_pat_personal");
    } finally {
      vi.unstubAllGlobals();
      vault.values.delete(personal.definitionId);
      vault.values.delete(work.definitionId);
      clearPersonalTokenOwnerCache();
    }
  });

  it("accepts the repository owner hint from the runtime credential route", async () => {
    const { input, workToken, personalToken } = await twoAccounts();
    const app = express();
    app.use(express.json());
    app.use(runtimeConnectionIntentRoutes(db));
    app.use(errorHandler);
    const token = createRuntimeToolsToken({ ...input, responsibleUserId: "A", scope: "github_credentials" })!.token;
    const post = (body: Record<string, unknown>) =>
      request(app).post("/runtime-tools/github/credentials").set("Authorization", `Bearer ${token}`).send(body);
    const work = await post({ repositoryOwner: "sentinan" });
    expect(work.status).toBe(200);
    expect(work.body).toMatchObject({ status: "available", login: "terryzhao2025" });
    expect(work.body.env.GH_TOKEN).toBe(workToken);
    expect((await post({ repositoryOwner: "byhashdong" })).body.env.GH_TOKEN).toBe(personalToken);
    // The hint cannot select a person or run; it only chooses among this run's accounts.
    expect((await post({ repositoryOwner: "sentinan", responsibleUserId: "B" })).body.login).toBe("terryzhao2025");
    expect((await post({ repositoryOwner: 42 })).body.status).toBe("unavailable");
  });
});
