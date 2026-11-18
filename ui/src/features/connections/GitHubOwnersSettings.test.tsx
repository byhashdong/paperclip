// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ToolConnection } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubOwnersSettings, parseGitHubOwners } from "./GitHubOwnersSettings";

const updateConnection = vi.hoisted(() => vi.fn());
const repositoryOptions = vi.hoisted(() => vi.fn());
vi.mock("@/api/tools", () => ({ toolsApi: { updateConnection: (...args: unknown[]) => updateConnection(...args) } }));
vi.mock("@/api/projects", () => ({ projectsApi: { repositoryOptions: (...args: unknown[]) => repositoryOptions(...args) } }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const connection = (githubOwners?: string) => ({
  id: "work",
  companyId: "company",
  config: {
    sourceTemplateKey: "github",
    connectionMethodKey: "mcp-key",
    url: "https://api.githubcopilot.com/mcp/",
    methodConfig: githubOwners === undefined ? {} : { githubOwners },
  },
}) as unknown as ToolConnection;

describe("parseGitHubOwners", () => {
  it("normalizes owners the way the server routes them", () => {
    expect(parseGitHubOwners("Sentinan, @web-biotech\nsentinan *")).toEqual({ owners: ["sentinan", "web-biotech", "*"], invalid: [] });
    expect(parseGitHubOwners("good, bad!").invalid).toEqual(["bad!"]);
  });
});

describe("GitHubOwnersSettings", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    updateConnection.mockReset().mockResolvedValue({});
    repositoryOptions.mockReset().mockResolvedValue({
      connectionCount: 2,
      failedConnectionCount: 0,
      repositories: [
        { id: "1", fullName: "sentinan/ecg-reporting", url: "", connections: ["Work"], connectionIds: ["work"] },
        { id: "2", fullName: "Web-Biotech/lims", url: "", connections: ["Work"], connectionIds: ["work"] },
        { id: "3", fullName: "byhashdong/paperclip", url: "", connections: ["Personal"], connectionIds: ["personal"] },
      ],
    });
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });
  const render = async (value: ToolConnection, canConfigure = true) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(<QueryClientProvider client={client}><GitHubOwnersSettings connection={value} canConfigure={canConfigure} /></QueryClientProvider>);
    });
    await act(async () => { await Promise.resolve(); });
  };
  const button = (label: string) => [...container.querySelectorAll("button")].find((candidate) => candidate.textContent === label);

  it("offers only this connection's owners and saves them into its own settings", async () => {
    await render(connection());
    await vi.waitFor(() => expect(container.textContent).toContain("Owners this connection can access: sentinan, web-biotech"));
    expect(container.textContent).not.toContain("byhashdong");
    await act(async () => { button("Use detected owners")!.click(); });
    await act(async () => { button("Save owners")!.click(); });
    expect(updateConnection).toHaveBeenCalledWith("work", {
      config: expect.objectContaining({
        sourceTemplateKey: "github",
        connectionMethodKey: "mcp-key",
        methodConfig: { githubOwners: "sentinan, web-biotech" },
      }),
    });
  });

  it("shows the saved owners and blocks invalid entries", async () => {
    await render(connection("byhashdong, *"));
    const input = container.querySelector("input")!;
    expect(input.value).toBe("byhashdong, *");
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(input, "byhashdong, not valid!");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.textContent).toContain("Not valid GitHub owners: valid!");
    expect(button("Save owners")!.disabled).toBe(true);
  });
});
