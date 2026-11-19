// @vitest-environment jsdom

import { classifyExecutionActivity, type ExecutionActivityFacts, type ExecutionProjection } from "@paperclipai/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@/context/ThemeContext";
import { MemoryRouter } from "@/lib/router";
import { TaskChatRunnerTurn } from "./TaskChatRunnerTurn";
import { TaskChatRequestHistoryContext } from "./TaskChatComposerTakeoverContext";
import { TaskChatLiveRunPill } from "./TaskChatLiveRunPill";
import type { TaskChatItem } from "./task-chat-model";

vi.mock("@/context/CompanyContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/context/CompanyContext")>()),
  useCompany: () => ({ selectedCompany: null }),
}));

const start = Date.parse("2026-11-18T03:10:56.000Z");
const at = (minutes: number) => new Date(start + minutes * 60_000).toISOString();

function projection(phase: ExecutionProjection["phase"], label: string, facts: Partial<ExecutionActivityFacts>, nowMs: number): ExecutionProjection {
  const base: ExecutionProjection = {
    phase, label, cause: null, lastConfirmedActivityAt: null, retryAt: null, attempt: 1, maxAttempts: 3,
    recoveryOwner: null, nextAction: null, permittedActions: ["inspect_run"], predecessorRunId: null, successorRunId: null,
  };
  // The server classifies at read time; the board re-classifies against its clock.
  base.activity = classifyExecutionActivity(base, {
    source: "provider_events", startedAt: at(0), lastConfirmedActivityAt: null, lastModelOutputAt: null,
    lastProgressAt: null, lastProgressSummary: null, openTool: null, ...facts,
  }, nowMs);
  return base;
}

describe("run activity on the task page", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  const renderTurn = (execution: ExecutionProjection, items: TaskChatItem[] = []) => act(() => root.render(
    <MemoryRouter>
      <ThemeProvider>
        <TaskChatRequestHistoryContext.Provider value="issue-1">
          <TaskChatRunnerTurn runId="run-1" agentName="Claude" agent={{ id: "agent-1" }} items={items}
            status="running" execution={execution} startedAtMs={start} />
        </TaskChatRequestHistoryContext.Provider>
      </ThemeProvider>
    </MemoryRouter>,
  ));
  const text = (testId: string) => container.querySelector(`[data-testid="${testId}"]`)?.textContent ?? null;

  it("shows a reconnect instead of Thinking, then escalates to a suspected stall with no new data (TER-19)", () => {
    vi.setSystemTime(start + 60_000);
    renderTurn(projection("reconnecting", "Confirming execution", { lastConfirmedActivityAt: at(0.4) }, Date.now()));
    expect(text("task-chat-current-activity-label")).toBe("Reconnecting");
    expect(text("task-chat-turn-status-header")).toContain("Reconnecting");
    expect(container.textContent).not.toContain("Thinking");
    expect(container.querySelector('[data-testid="run-activity-alert"]')).toBeNull();
    expect(text("run-activity-last-activity")).toBe("Last activity 36s ago");
    expect(text("run-activity-last-progress")).toBe("No effective action yet");

    // The stopped run sends nothing more: the clock alone moves it to a stall.
    act(() => { vi.setSystemTime(start + 23.5 * 3_600_000); vi.advanceTimersByTime(1_000); });
    expect(text("task-chat-current-activity-label")).toBe("Possibly stalled");
    const alert = container.querySelector('[data-testid="run-activity-alert"]');
    expect(alert?.getAttribute("role")).toBe("alert");
    expect(alert?.textContent).toMatch(/has not confirmed this run's agent process for 23h 29m/);
    expect(container.querySelector('[data-testid="run-activity-open-run"]')?.getAttribute("href")).toBe("/agents/agent-1/runs/run-1");
  });

  it("stops showing a streaming Thinking row once the run is suspected stalled", () => {
    const items: TaskChatItem[] = [
      { id: "tool", kind: "tool", name: "Command", rawName: "bash", status: "completed" },
      { id: "thinking", kind: "thinking", lines: [], lifecycleOnly: true, streaming: true },
    ];
    vi.setSystemTime(start + 60_000);
    renderTurn(projection("working", "Working", { lastConfirmedActivityAt: at(0.9), lastModelOutputAt: at(0.9) }, Date.now()), items);
    expect(text("task-chat-activity-viewport")).toBe("Thinking");
    expect(text("task-chat-turn-status-header")).toContain("Generating");

    act(() => { vi.setSystemTime(start + 20 * 60_000); vi.advanceTimersByTime(1_000); });
    expect(text("task-chat-turn-status-header")).toContain("Possibly stalled");
    expect(text("task-chat-activity-viewport")).not.toBe("Thinking");
    expect(container.querySelector('[data-testid="run-activity-alert"]')?.textContent).toMatch(/no output or tool activity for 19m/);
  });

  it("names a confirmed run with zero model output and shows the latest effective progress otherwise", () => {
    vi.setSystemTime(start + 6 * 60_000);
    renderTurn(projection("working", "Working", { lastConfirmedActivityAt: at(0.2) }, Date.now()));
    expect(text("task-chat-current-activity-label")).toBe("No model output yet");
    expect(container.querySelector('[data-testid="run-activity-alert"]')?.textContent).toMatch(/no output/);

    renderTurn(projection("working", "Working", {
      lastConfirmedActivityAt: at(5.9), lastModelOutputAt: at(5.9), lastProgressAt: at(4), lastProgressSummary: "Ran Bash · pnpm verify",
    }, Date.now()));
    expect(text("task-chat-current-activity-label")).toBe("Generating");
    expect(text("run-activity-last-progress")).toBe("Last progress 2m ago: Ran Bash · pnpm verify");
    expect(container.querySelector('[data-testid="run-activity-alert"]')).toBeNull();
  });

  it("uses the activity label in the live run pill", () => {
    vi.setSystemTime(start + 60_000);
    act(() => root.render(
      <TaskChatLiveRunPill status="running" startedAtMs={start} toolSummary={null}
        execution={projection("working", "Working", { lastConfirmedActivityAt: at(0.9), lastModelOutputAt: at(0.5),
          openTool: { name: "Bash", readOnly: false, startedAt: at(0.8) } }, Date.now())} />,
    ));
    expect(container.textContent).toContain("Running Bash");
  });
});
