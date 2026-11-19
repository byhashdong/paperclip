import { describe, expect, it } from "vitest";
import {
  classifyExecutionActivity,
  formatActivityDuration,
  type ExecutionActivityFacts,
} from "./execution-activity.js";

const start = Date.parse("2026-11-18T03:10:56.000Z");
const at = (minutes: number) => new Date(start + minutes * 60_000).toISOString();
const facts = (overrides: Partial<ExecutionActivityFacts> = {}): ExecutionActivityFacts => ({
  source: "provider_events",
  startedAt: at(0),
  lastConfirmedActivityAt: null,
  lastModelOutputAt: null,
  lastProgressAt: null,
  lastProgressSummary: null,
  openTool: null,
  ...overrides,
});
const working = { phase: "working" as const, label: "Working", cause: null, nextAction: null };
const reconnecting = { phase: "reconnecting" as const, label: "Confirming execution", cause: null, nextAction: null };

describe("classifyExecutionActivity", () => {
  it("shows generating while the model streams and a running tool by name", () => {
    const streaming = facts({ lastConfirmedActivityAt: at(2), lastModelOutputAt: at(2), lastProgressAt: at(1), lastProgressSummary: "Ran Bash" });
    expect(classifyExecutionActivity(working, streaming, Date.parse(at(2.5)))).toMatchObject({ state: "generating", label: "Generating", attention: "none" });
    const tool = { ...streaming, openTool: { name: "Bash", readOnly: false, startedAt: at(2) } };
    expect(classifyExecutionActivity(working, tool, Date.parse(at(3)))).toMatchObject({ state: "running_tool", label: "Running Bash" });
  });

  it("waits for the first model output before it is overdue", () => {
    const quiet = facts({ lastConfirmedActivityAt: at(0.2) });
    expect(classifyExecutionActivity(working, quiet, Date.parse(at(1)))).toMatchObject({ state: "waiting_for_model", attention: "none" });
  });

  it("flags zero model output after five minutes with a next step", () => {
    const quiet = facts({ lastConfirmedActivityAt: at(0.2) });
    const activity = classifyExecutionActivity(working, quiet, Date.parse(at(6)));
    expect(activity).toMatchObject({ state: "no_progress", label: "No model output yet", attention: "warning" });
    expect(activity?.nextAction).toMatch(/stop the run and retry/);
  });

  it("does not count lookups as effective progress", () => {
    // Model output and page reads continue, but no message, edit or command for 16 minutes.
    const lookingAround = facts({
      lastConfirmedActivityAt: at(16), lastModelOutputAt: at(16), lastProgressAt: null,
      openTool: { name: "get_task_context", readOnly: true, startedAt: at(16) },
    });
    expect(classifyExecutionActivity(working, lookingAround, Date.parse(at(16.1)))).toMatchObject({
      state: "no_progress", label: "No effective action", attention: "warning",
    });
  });

  it("keeps a long-running command as running a tool", () => {
    const tests = facts({
      lastConfirmedActivityAt: at(19), lastModelOutputAt: at(1), lastProgressAt: at(1), lastProgressSummary: "Started Bash",
      openTool: { name: "Bash", readOnly: false, startedAt: at(1) },
    });
    expect(classifyExecutionActivity(working, tests, Date.parse(at(19.5)))).toMatchObject({ state: "running_tool", attention: "none" });
  });

  it("calls a run silent for fifteen minutes a suspected stall", () => {
    const silent = facts({ lastConfirmedActivityAt: at(3), lastModelOutputAt: at(3), lastProgressAt: at(3), lastProgressSummary: "Ran Bash" });
    const activity = classifyExecutionActivity(working, silent, Date.parse(at(18)));
    expect(activity).toMatchObject({ state: "suspected_stall", label: "Possibly stalled", attention: "critical", silentForMs: 15 * 60_000 });
    expect(activity?.nextAction).toMatch(/for 15m/);
  });

  it("turns a lasting reconnect with zero model output into a suspected stall (TER-19)", () => {
    // The process stopped after a restart: the projection could no longer
    // confirm execution, and the agent never produced model output.
    const zeroOutput = facts({ lastConfirmedActivityAt: at(0.4) });
    expect(classifyExecutionActivity(reconnecting, zeroOutput, Date.parse(at(1)))).toMatchObject({ state: "reconnecting", label: "Reconnecting" });
    const later = classifyExecutionActivity(reconnecting, zeroOutput, Date.parse(at(60 * 23.5)));
    expect(later).toMatchObject({ state: "suspected_stall", attention: "critical" });
    expect(later?.nextAction).toMatch(/23h 29m/);
  });

  it("names cleanup and external-input waits", () => {
    expect(classifyExecutionActivity({ phase: "finishing", label: "Finishing", cause: null, nextAction: null }, facts()))
      .toMatchObject({ state: "waiting_for_cleanup", label: "Finishing and cleaning up" });
    expect(classifyExecutionActivity({ phase: "queued", label: "Waiting for previous run to stop", cause: "previous_run_settling", nextAction: "x" }, facts()))
      .toMatchObject({ state: "waiting_for_cleanup", nextAction: "x" });
    expect(classifyExecutionActivity({ phase: "waiting_for_answer", label: "Waiting for answer", cause: null, nextAction: null }, facts()))
      .toMatchObject({ state: "waiting_for_input", label: "Waiting for answer" });
    expect(classifyExecutionActivity({ phase: "waiting_for_provider", label: "Waiting for Muse", cause: null, nextAction: null }, facts()))
      .toMatchObject({ state: "waiting_for_input" });
  });

  it("leaves phases the label already explains alone", () => {
    for (const phase of ["completed", "failed", "recovery_needed", "retry_scheduled"] as const) {
      expect(classifyExecutionActivity({ phase, label: "x", cause: null, nextAction: null }, facts())).toBeNull();
    }
    expect(classifyExecutionActivity({ phase: "queued", label: "Queued", cause: null, nextAction: null }, facts())).toBeNull();
  });

  it("uses process output only for runs without typed provider events", () => {
    const legacy = facts({ source: "process_output", lastConfirmedActivityAt: at(1), lastModelOutputAt: at(1), lastProgressAt: at(1) });
    expect(classifyExecutionActivity(working, legacy, Date.parse(at(14)))?.state).toBe("generating");
    expect(classifyExecutionActivity(working, legacy, Date.parse(at(16)))?.state).toBe("suspected_stall");
  });
});

describe("formatActivityDuration", () => {
  it("formats compact durations", () => {
    expect(formatActivityDuration(45_000)).toBe("45s");
    expect(formatActivityDuration(12 * 60_000)).toBe("12m");
    expect(formatActivityDuration(185 * 60_000)).toBe("3h 5m");
    expect(formatActivityDuration(52 * 3_600_000)).toBe("2d 4h");
  });
});
