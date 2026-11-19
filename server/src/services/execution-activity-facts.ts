import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import type { ExecutionActivityFacts } from "@paperclipai/shared";

/**
 * Provider-originated event types. Everything else in a run's event stream is
 * Paperclip bookkeeping (lifecycle notes, timing spans, lease and process
 * records, diagnostics, goal and capability snapshots) and token usage
 * counters: none of it shows the agent doing anything, so none of it counts as
 * activity. Board page reads and polls never write run events at all.
 */
const PROVIDER_EVENT_TYPES = [
  "item.delta",
  "item.started",
  "item.completed",
  "tool.execution.started",
  "tool.execution.progressed",
  "tool.execution.completed",
  "turn.started",
  "turn.completed",
  "run.result.proposed",
] as const;
/** Newest provider events read per run. Older evidence only makes the answer more conservative. */
export const EXECUTION_ACTIVITY_EVENT_WINDOW = 200;
/** Running native runs read per batch; the rest fall back to process output timestamps. */
export const MAX_EXECUTION_ACTIVITY_RUNS = 32;

export type ActivityEventRow = {
  runId: string;
  eventType: string;
  createdAt: Date | string;
  kind: string | null;
  name: string | null;
  readOnly: string | null;
  operation: string | null;
  executionId: string | null;
  detail: string | null;
  text: string | null;
};

export interface ActivityRunInput {
  id: string;
  status: string;
  runtimeMode: string | null;
  startedAt: Date | null;
  lastOutputAt: Date | null;
}

const iso = (value: Date | string | null | undefined) =>
  value == null ? null : new Date(value).toISOString();

const LOOKUP_TOOL_NAMES = new Set([
  "read", "readfile", "glob", "grep", "ls", "toolsearch", "webfetch", "websearch",
  "taskget", "tasklist", "view_image", "imageview",
]);

/** Display name without MCP server prefixes and generated hash suffixes. */
export function toolDisplayName(name: string): string {
  return name
    .replace(/^mcp__[^_]+(?:_[^_]+)*?__/, "")
    .replace(/^app_mcp_app_gallery_/, "")
    .replace(/_[0-9a-f]{12}$/, "");
}

/**
 * Reading files, task pages or catalogs is activity, not progress. The
 * provider's readOnly flag is set only for some built-in readers, so lookup
 * verbs in the tool name count too.
 */
export function isLookupTool(name: string | null, readOnly: string | null, operation: string | null): boolean {
  if (readOnly === "true" || operation === "read") return true;
  if (!name) return false;
  const display = toolDisplayName(name).toLowerCase();
  if (LOOKUP_TOOL_NAMES.has(display)) return true;
  return /(^|_)(get|list|search|read|fetch|find|view|query|show|describe|inspect)(_|$)/.test(display);
}

const clip = (value: string, max: number) => {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

function progressSummary(row: ActivityEventRow): string | null {
  if (row.eventType === "item.completed" && row.kind === "agentMessage") {
    return row.text?.trim() ? `Wrote: “${clip(row.text, 100)}”` : "Wrote a message";
  }
  if (row.eventType === "item.completed" && row.kind === "fileChange") return "Changed files";
  if ((row.eventType === "tool.execution.completed" || row.eventType === "tool.execution.started")
    && row.name && !isLookupTool(row.name, row.readOnly, row.operation)) {
    const verb = row.eventType === "tool.execution.completed" ? "Ran" : "Started";
    const detail = row.detail?.trim() ? ` · ${clip(row.detail, 80)}` : "";
    return `${verb} ${toolDisplayName(row.name)}${detail}`;
  }
  if (row.eventType === "run.result.proposed") return "Proposed the run result";
  if (row.eventType === "turn.completed") return "Finished a turn";
  return null;
}

function isModelOutput(row: ActivityEventRow): boolean {
  if (row.eventType === "item.delta") return true;
  return row.eventType === "item.completed"
    && (row.kind === "agentMessage" || row.kind === "reasoning" || row.kind === "plan");
}

/**
 * Derive facts from a run's newest provider events (newest first). When the
 * window is full, missing model output or progress is bounded by the oldest
 * event read, which can only understate how long the run has been quiet.
 */
export function activityFactsFromEvents(
  run: Pick<ActivityRunInput, "startedAt">,
  rows: readonly ActivityEventRow[],
  windowFull: boolean,
): ExecutionActivityFacts {
  const facts: ExecutionActivityFacts = {
    source: "provider_events",
    startedAt: iso(run.startedAt),
    lastConfirmedActivityAt: iso(rows[0]?.createdAt),
    lastModelOutputAt: null,
    lastProgressAt: null,
    lastProgressSummary: null,
    openTool: null,
  };
  let toolSeen = false;
  for (const row of rows) {
    if (!facts.lastModelOutputAt && isModelOutput(row)) facts.lastModelOutputAt = iso(row.createdAt);
    if (!facts.lastProgressAt) {
      const summary = progressSummary(row);
      if (summary) {
        facts.lastProgressAt = iso(row.createdAt);
        facts.lastProgressSummary = summary;
      }
    }
    if (!toolSeen && row.eventType.startsWith("tool.execution.")) {
      toolSeen = true;
      if (row.eventType !== "tool.execution.completed" && row.name) {
        const started = rows.filter(other => other.eventType === "tool.execution.started"
          && row.executionId && other.executionId === row.executionId).at(-1);
        facts.openTool = {
          name: toolDisplayName(row.name),
          readOnly: isLookupTool(row.name, row.readOnly, row.operation),
          startedAt: iso(started?.createdAt ?? row.createdAt)!,
        };
      }
    }
  }
  if (windowFull && rows.length) {
    const oldest = iso(rows.at(-1)!.createdAt);
    facts.lastModelOutputAt ??= oldest;
    facts.lastProgressAt ??= oldest;
  }
  return facts;
}

/** Raw process output is the only evidence for runs without typed provider events. */
export function activityFactsFromProcessOutput(run: ActivityRunInput): ExecutionActivityFacts {
  const output = iso(run.lastOutputAt);
  return {
    source: "process_output",
    startedAt: iso(run.startedAt),
    lastConfirmedActivityAt: output,
    lastModelOutputAt: output,
    lastProgressAt: output,
    lastProgressSummary: null,
    openTool: null,
  };
}

/** One bounded batched read for the running native runs; no per-task polling. */
export async function readExecutionActivityFacts(
  db: Db,
  companyId: string,
  runs: readonly ActivityRunInput[],
  read: <T>(query: () => Promise<T>) => Promise<T> = query => query(),
): Promise<Map<string, ExecutionActivityFacts>> {
  const facts = new Map<string, ExecutionActivityFacts>();
  const running = runs.filter(run => run.status === "running");
  const native = running.filter(run => run.runtimeMode === "native").slice(0, MAX_EXECUTION_ACTIVITY_RUNS);
  const nativeIds = new Set(native.map(run => run.id));
  for (const run of runs) if (!nativeIds.has(run.id)) facts.set(run.id, activityFactsFromProcessOutput(run));
  if (!native.length) return facts;
  const rows = await read(async () => [...await db.execute<ActivityEventRow>(sql`
    select target.id as "runId", e.event_type as "eventType", e.created_at as "createdAt",
      e.p->>'kind' as kind, e.p->>'name' as name, e.p->>'readOnly' as "readOnly",
      e.p->>'operation' as operation, e.p->>'executionId' as "executionId",
      left(coalesce(e.p->>'description', e.p->>'subject', e.p->>'target'), 200) as detail,
      left(e.p->>'text', 200) as text
    from unnest(${sql.param(native.map(run => run.id))}::uuid[]) as target(id)
    cross join lateral (
      select ev.event_type, ev.created_at, ev.seq,
        coalesce(ev.payload->'prpEvent'->'payload', ev.payload) as p
      from heartbeat_run_events ev
      where ev.run_id = target.id
        and ev.company_id = ${companyId}
        and ev.event_type in (${sql.join(PROVIDER_EVENT_TYPES.map(type => sql`${type}`), sql`, `)})
        and not (ev.event_type = 'item.completed'
          and coalesce(ev.payload->'prpEvent'->'payload'->>'kind', ev.payload->>'kind') is not distinct from 'usage')
      order by ev.seq desc
      limit ${EXECUTION_ACTIVITY_EVENT_WINDOW}
    ) e
    order by target.id, e.seq desc`)]);
  const byRun = new Map<string, ActivityEventRow[]>();
  for (const row of rows) {
    const list = byRun.get(row.runId) ?? [];
    list.push(row);
    byRun.set(row.runId, list);
  }
  for (const run of native) {
    const list = byRun.get(run.id) ?? [];
    facts.set(run.id, activityFactsFromEvents(run, list, list.length >= EXECUTION_ACTIVITY_EVENT_WINDOW));
  }
  return facts;
}
