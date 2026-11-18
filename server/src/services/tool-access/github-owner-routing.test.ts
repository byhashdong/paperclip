import { describe, expect, it } from "vitest";
import {
  configuredGitHubOwners,
  githubOwnerFromRemoteUrl,
  githubOwnerFromToolArguments,
  grantGitHubOwners,
  invalidGitHubOwnerEntries,
  parseGitHubOwnerList,
  routeGitHubCandidatesByOwner,
} from "./github-owner-routing.js";

const connection = (id: string, githubOwners?: string, createdAt = "2026-01-01") => ({
  id,
  createdAt: new Date(createdAt),
  config: {
    sourceTemplateKey: "github",
    connectionMethodKey: "mcp-key",
    methodConfig: githubOwners === undefined ? {} : { githubOwners },
  },
});
const grant = (id: string, connectionId: string, github?: Record<string, unknown>) => ({
  id,
  connectionId,
  providerTenant: github ? { github } : null,
});

describe("GitHub owner lists", () => {
  it("parses comma, space, and newline separated owners case-insensitively", () => {
    expect(parseGitHubOwnerList("Sentinan, web-biotech\n@ByHashDong ; *")).toEqual([
      "sentinan", "web-biotech", "byhashdong", "*",
    ]);
    expect(parseGitHubOwnerList(["a", "bad owner!", "-x", 3])).toEqual(["a"]);
    expect(parseGitHubOwnerList(undefined)).toEqual([]);
    expect(invalidGitHubOwnerEntries("good, bad!, -lead, *")).toEqual(["bad!", "-lead"]);
  });

  it("reads the setting only from GitHub connections", () => {
    expect(configuredGitHubOwners(connection("c", "sentinan"))).toEqual(["sentinan"]);
    expect(configuredGitHubOwners(connection("c", "  "))).toBeNull();
    expect(configuredGitHubOwners(connection("c"))).toBeNull();
    expect(configuredGitHubOwners({ id: "x", config: { sourceTemplateKey: "slack", methodConfig: { githubOwners: "a" } } })).toBeNull();
  });

  it("derives owners from an access snapshot", () => {
    expect(grantGitHubOwners(grant("g", "c", {
      login: "TerryZhao2025",
      installationOwnerLogins: ["Sentinan"],
      repositories: [{ fullName: "web-biotech/lims" }, { fullName: "sentinan/ecg-reporting" }],
    })).sort()).toEqual(["sentinan", "terryzhao2025", "web-biotech"]);
    expect(grantGitHubOwners(grant("g", "c"))).toEqual([]);
  });
});

describe("GitHub operation owners", () => {
  it.each([
    ["https://github.com/sentinan/ecg-reporting.git", "sentinan"],
    ["https://www.github.com/Sentinan/ecg-reporting", "sentinan"],
    ["git@github.com:byhashdong/paperclip.git", "byhashdong"],
    ["ssh://git@github.com/byhashdong/paperclip.git", "byhashdong"],
    ["https://api.github.com/repos/sentinan/ecg-reporting/pulls", "sentinan"],
    ["https://gitlab.com/sentinan/ecg-reporting.git", null],
    ["not a url", null],
  ])("reads %s", (url, owner) => {
    expect(githubOwnerFromRemoteUrl(url)).toBe(owner);
  });

  it("reads owners from GitHub MCP tool arguments", () => {
    expect(githubOwnerFromToolArguments({ owner: "Sentinan", repo: "ecg-reporting" })).toBe("sentinan");
    expect(githubOwnerFromToolArguments({ repo: "byhashdong/paperclip" })).toBe("byhashdong");
    expect(githubOwnerFromToolArguments({ url: "https://github.com/web-biotech/lims/pull/3" })).toBe("web-biotech");
    expect(githubOwnerFromToolArguments({ name: "new-repo", organization: "sentinan" })).toBe("sentinan");
    expect(githubOwnerFromToolArguments({ query: "fix in:title repo:sentinan/ecg-reporting" })).toBe("sentinan");
    expect(githubOwnerFromToolArguments({ query: "org:web-biotech language:ts" })).toBe("web-biotech");
    expect(githubOwnerFromToolArguments({ query: "unqualified search" })).toBeNull();
    expect(githubOwnerFromToolArguments({})).toBeNull();
    expect(githubOwnerFromToolArguments(undefined)).toBeNull();
  });
});

describe("routing between GitHub connections", () => {
  const personal = connection("personal", "byhashdong", "2026-01-01");
  const work = connection("work", "sentinan, web-biotech", "2026-02-01");
  const personalGrant = grant("g-personal", "personal");
  const workGrant = grant("g-work", "work");
  const route = (owner: string | null, mode?: "operation" | "catalog", connections = [personal, work]) =>
    routeGitHubCandidatesByOwner({ candidates: [personalGrant, workGrant], connections, owner, mode });

  it("sends each owner to the connection responsible for it", () => {
    expect(route("sentinan").candidates).toEqual([workGrant]);
    expect(route("Web-Biotech").candidates).toEqual([workGrant]);
    expect(route("byhashdong").candidates).toEqual([personalGrant]);
  });

  it("reports an owner no connection is responsible for instead of guessing", () => {
    const result = route("someone-else");
    expect(result.candidates).toEqual([]);
    expect(result.ownerUnmatched).toBe(true);
    expect(result.error).toMatch(/No GitHub connection is responsible for "someone-else"/);
  });

  it("requires an owner or a default connection when several accounts are connected", () => {
    expect(route(null).error).toMatch(/More than one GitHub account is connected/);
    expect(route(null).candidates).toEqual([]);
    const defaulted = [connection("personal", "byhashdong, *"), work];
    expect(route(null, "operation", defaulted).candidates).toEqual([personalGrant]);
    expect(route("someone-else", "operation", defaulted).candidates).toEqual([personalGrant]);
    expect(route("sentinan", "operation", defaulted).candidates).toEqual([workGrant]);
  });

  it("lists one stable connection's tools for agents", () => {
    expect(route(null, "catalog").candidates).toEqual([personalGrant]);
    expect(route(null, "catalog", [connection("personal", "byhashdong", "2026-03-01"), work]).candidates).toEqual([workGrant]);
  });

  it("answers an ownerless operation with the connection it was asked about", () => {
    expect(routeGitHubCandidatesByOwner({
      candidates: [personalGrant, workGrant], connections: [personal, work], owner: null, connectionId: "work",
    }).candidates).toEqual([workGrant]);
  });

  it("uses access snapshots for connections without the setting", () => {
    const candidates = [
      grant("a", "personal", { userId: "1", login: "byhashdong", installationOwnerLogins: ["byhashdong"] }),
      grant("b", "work", { userId: "2", login: "terryzhao2025", installationOwnerLogins: ["sentinan"] }),
    ];
    const connections = [connection("personal"), connection("work")];
    expect(routeGitHubCandidatesByOwner({ candidates, connections, owner: "sentinan" }).candidates).toEqual([candidates[1]]);
    expect(routeGitHubCandidatesByOwner({ candidates, connections, owner: "byhashdong" }).candidates).toEqual([candidates[0]]);
    expect(routeGitHubCandidatesByOwner({ candidates, connections, owner: "nobody" }).ownerUnmatched).toBe(true);
    // A configured list is authoritative for its connection, even over its snapshot.
    const configured = [connection("personal", "byhashdong"), connection("work")];
    expect(routeGitHubCandidatesByOwner({
      candidates: [grant("a", "personal", { userId: "1", installationOwnerLogins: ["sentinan"] }), candidates[1]!],
      connections: configured, owner: "sentinan",
    }).candidates).toEqual([candidates[1]]);
  });

  it("uses the owners a personal access token reaches when its connection lists none", () => {
    const candidates = [grant("a", "personal"), grant("b", "work")];
    const connections = [connection("personal"), connection("work")];
    const detectedOwners = new Map([["a", ["byhashdong"]], ["b", ["sentinan"]]]);
    expect(routeGitHubCandidatesByOwner({ candidates, connections, owner: "sentinan", detectedOwners }).candidates).toEqual([candidates[1]]);
    expect(routeGitHubCandidatesByOwner({ candidates, connections, owner: "byhashdong", detectedOwners }).candidates).toEqual([candidates[0]]);
    expect(routeGitHubCandidatesByOwner({ candidates, connections, owner: "octocat", detectedOwners }).ownerUnmatched).toBe(true);
    // Without detection, two token connections handle nothing rather than guessing.
    expect(routeGitHubCandidatesByOwner({ candidates, connections, owner: "sentinan" }).ownerUnmatched).toBe(true);
    // A saved list stays authoritative over what the token reaches.
    expect(routeGitHubCandidatesByOwner({
      candidates, connections: [connection("personal"), connection("work", "web-biotech")], owner: "sentinan", detectedOwners,
    }).ownerUnmatched).toBe(true);
  });

  it("keeps a single connected account serving every owner unless it lists owners", () => {
    const only = [grant("a", "personal", { userId: "1", login: "byhashdong" })];
    expect(routeGitHubCandidatesByOwner({ candidates: only, connections: [connection("personal")], owner: "anyone" }).candidates).toEqual(only);
    expect(routeGitHubCandidatesByOwner({ candidates: only, connections: [connection("personal")], owner: null }).candidates).toEqual(only);
    const restricted = routeGitHubCandidatesByOwner({ candidates: only, connections: [connection("personal", "byhashdong")], owner: "anyone" });
    expect(restricted.ownerUnmatched).toBe(true);
    // Duplicate authorizations for one GitHub account are not several accounts.
    const duplicates = [
      grant("a", "personal", { userId: "1" }),
      grant("b", "work", { userId: "1" }),
    ];
    expect(routeGitHubCandidatesByOwner({ candidates: duplicates, connections: [connection("personal"), connection("work")], owner: null }).candidates)
      .toEqual(duplicates);
  });
});
