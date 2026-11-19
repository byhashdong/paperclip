import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRunEvents, heartbeatRuns, issues, nativeRunFinalizations } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { activityFactsFromEvents, isLookupTool, toolDisplayName, type ActivityEventRow } from "./execution-activity-facts.js";
import { executionProjectionsForRuns } from "./execution-projection.js";

const start = new Date("2026-11-18T03:10:56.000Z");
const at = (minutes: number) => new Date(start.getTime() + minutes * 60_000);
const row = (eventType: string, minutes: number, extra: Partial<ActivityEventRow> = {}): ActivityEventRow => ({
  runId: "run", eventType, createdAt: at(minutes), kind: null, name: null, readOnly: null,
  operation: null, executionId: null, detail: null, text: null, ...extra,
});

describe("activity facts from provider events", () => {
  it("separates lookups from effective tool calls", () => {
    expect(isLookupTool("Read", "true", "read")).toBe(true);
    expect(isLookupTool("ToolSearch", "false", "execute")).toBe(true);
    expect(isLookupTool("mcp__paperclip__get_task_context", null, "unknown")).toBe(true);
    expect(isLookupTool("app_mcp_app_gallery_gith_list_pull_requests_19c0cb12f5a5", "false", "execute")).toBe(true);
    expect(isLookupTool("Bash", "false", "execute")).toBe(false);
    expect(isLookupTool("Edit", "false", "edit")).toBe(false);
    expect(isLookupTool("paperclip_finish", "false", "execute")).toBe(false);
    expect(toolDisplayName("mcp__claude_ai_Slack__send_message")).toBe("send_message");
  });

  it("reads model output, the latest effective action and an open tool (newest first)", () => {
    const facts = activityFactsFromEvents({ startedAt: start }, [
      row("tool.execution.progressed", 9, { name: "Bash", executionId: "t2" }),
      row("tool.execution.started", 8, { name: "Bash", executionId: "t2", detail: "pnpm test" }),
      row("tool.execution.completed", 7, { name: "get_task", executionId: "t1" }),
      row("item.delta", 6, { kind: "agentMessage" }),
      row("item.completed", 5, { kind: "agentMessage", text: "Starting the   review\nnow" }),
    ], false);
    expect(facts).toMatchObject({
      source: "provider_events",
      lastConfirmedActivityAt: at(9).toISOString(),
      lastModelOutputAt: at(6).toISOString(),
      lastProgressAt: at(8).toISOString(),
      lastProgressSummary: "Started Bash · pnpm test",
      openTool: { name: "Bash", readOnly: false, startedAt: at(8).toISOString() },
    });
  });

  it("summarizes messages when only lookups follow them", () => {
    const facts = activityFactsFromEvents({ startedAt: start }, [
      row("tool.execution.completed", 7, { name: "Read", readOnly: "true", operation: "read" }),
      row("item.completed", 5, { kind: "agentMessage", text: "Starting the   review\nnow" }),
    ], false);
    expect(facts.lastProgressSummary).toBe("Wrote: “Starting the review now”");
    expect(facts.openTool).toBeNull();
  });

  it("bounds unseen evidence by the oldest event when the window is full", () => {
    const facts = activityFactsFromEvents({ startedAt: start }, [
      row("tool.execution.completed", 30, { name: "Read", readOnly: "true" }),
      row("tool.execution.completed", 20, { name: "Grep" }),
    ], true);
    expect(facts.lastModelOutputAt).toBe(at(20).toISOString());
    expect(facts.lastProgressAt).toBe(at(20).toISOString());
    expect(facts.lastProgressSummary).toBeNull();
  });
});

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("execution activity projection", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let agentId: string;
  beforeAll(async () => {
    // Always a disposable test database; never use an operator's DATABASE_URL.
    database = await startEmbeddedPostgresTestDatabase("execution-activity-");
    db = createDb(database.connectionString);
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Activity test", issuePrefix: `A${companyId.slice(0, 8)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Claude", adapterType: "paperclip_runner" });
  }, 60_000);
  afterAll(async () => { await database?.cleanup(); });

  async function nativeRun(options: { leaseUntil: Date | null; events: Array<{ type: string; minutes: number; payload?: Record<string, unknown> }> }) {
    const issueId = randomUUID(), runId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Live work", assigneeAgentId: agentId, status: "in_progress" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId,
      runtimeMode: "native", status: "running", driverKind: "acpx_runtime", startedAt: start,
      // Raw process output keeps moving: usage counters and spans are logged too.
      lastOutputAt: at(Math.max(0, ...options.events.map(event => event.minutes))) });
    if (options.leaseUntil) {
      await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed",
        leaseExpiresAt: options.leaseUntil, controllerGeneration: 1 });
    }
    let seq = 0;
    for (const event of options.events) {
      seq += 1;
      await db.insert(heartbeatRunEvents).values({ companyId, runId, agentId, seq, eventType: event.type,
        stream: "system", createdAt: at(event.minutes),
        payload: { prpEvent: { runId, schema: "paperclip.prp.event.v1", payload: event.payload ?? {} } } });
    }
    return runId;
  }
  const usage = (minutes: number) => ({ type: "item.completed", minutes, payload: { kind: "usage", usage: { total: { requests: 1 } } } });
  const span = (minutes: number) => ({ type: "run.performance.span", minutes });

  it("shows a reconnect with zero model output as a suspected stall, ignoring usage and spans (TER-19)", async () => {
    const runId = await nativeRun({
      leaseUntil: null,
      events: [
        { type: "turn.started", minutes: 0.3 },
        { type: "tool.execution.started", minutes: 0.4, payload: { name: "get_task_context", operation: "unknown", executionId: "a" } },
        { type: "tool.execution.completed", minutes: 0.45, payload: { name: "get_task_context", operation: "unknown", executionId: "a" } },
        usage(40), span(41), { type: "lifecycle", minutes: 42 },
      ],
    });
    const projection = (await executionProjectionsForRuns(db, companyId, [runId], at(45))).get(runId)!;
    expect(projection).toMatchObject({ phase: "reconnecting", label: "Confirming execution" });
    expect(projection.activity).toMatchObject({
      state: "suspected_stall", attention: "critical",
      lastConfirmedActivityAt: at(0.45).toISOString(), lastModelOutputAt: null, lastProgressAt: null,
    });
    expect(projection.lastConfirmedActivityAt).toBe(at(0.45).toISOString());
    // Shortly after the restart the same run reads as reconnecting, not thinking.
    const early = (await executionProjectionsForRuns(db, companyId, [runId], at(2))).get(runId)!;
    expect(early.activity).toMatchObject({ state: "reconnecting", label: "Reconnecting" });
  });

  it("flags a confirmed run with no model output and keeps a streaming run as generating", async () => {
    const silent = await nativeRun({ leaseUntil: at(60), events: [{ type: "turn.started", minutes: 0.2 }, usage(5), span(6)] });
    const streaming = await nativeRun({ leaseUntil: at(60), events: [
      { type: "turn.started", minutes: 0.2 },
      { type: "tool.execution.started", minutes: 1, payload: { name: "Bash", operation: "execute", readOnly: false, executionId: "b", description: "pnpm verify" } },
      { type: "tool.execution.completed", minutes: 2, payload: { name: "Bash", operation: "execute", readOnly: false, executionId: "b" } },
      { type: "item.delta", minutes: 6.5, payload: { kind: "agentMessage", text: "All checks" } },
    ] });
    const projections = await executionProjectionsForRuns(db, companyId, [silent, streaming], at(7));
    expect(projections.get(silent)).toMatchObject({ phase: "working" });
    expect(projections.get(silent)?.activity).toMatchObject({ state: "no_progress", label: "No model output yet", attention: "warning" });
    expect(projections.get(streaming)?.activity).toMatchObject({
      state: "generating", lastProgressSummary: "Ran Bash", lastProgressAt: at(2).toISOString(),
    });
  });
});
