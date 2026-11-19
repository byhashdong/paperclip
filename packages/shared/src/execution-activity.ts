import type { ExecutionProjection } from "./types/execution-projection.js";

/**
 * What a run is doing now, in user terms. One pure classifier shared by the
 * server (API projection) and the board (re-evaluated against the clock while
 * the page is open), so the task page, run detail and API never disagree.
 */
export type ExecutionActivityState =
  | "waiting_for_model"
  | "generating"
  | "running_tool"
  | "reconnecting"
  | "waiting_for_cleanup"
  | "waiting_for_input"
  | "no_progress"
  | "suspected_stall";

/** A run with no model output this long after it started has made no progress. */
export const EXECUTION_ACTIVITY_NO_OUTPUT_MS = 5 * 60 * 1000;
/** Reconnecting this long without a confirmed provider event is a suspected stall. */
export const EXECUTION_ACTIVITY_RECONNECT_STALL_MS = 5 * 60 * 1000;
/** Activity without an effective action this long is "no effective action". */
export const EXECUTION_ACTIVITY_NO_PROGRESS_MS = 15 * 60 * 1000;
/** No confirmed provider event at all this long is a suspected stall. */
export const EXECUTION_ACTIVITY_STALL_MS = 15 * 60 * 1000;

/**
 * Evidence read from the run's own provider event stream. Only provider
 * events count: board page reads and polls, token usage counters, timing
 * spans, diagnostics and lease bookkeeping never move these timestamps.
 */
export interface ExecutionActivityFacts {
  /** "provider_events": typed native events. "process_output": raw process output only. */
  source: "provider_events" | "process_output";
  startedAt: string | null;
  /** Latest provider event: model output, tool events, turn events. */
  lastConfirmedActivityAt: string | null;
  /** Latest model text or reasoning output. */
  lastModelOutputAt: string | null;
  /** Latest effective action: a message, a non-read-only tool call, a file change or a result. */
  lastProgressAt: string | null;
  lastProgressSummary: string | null;
  /** The most recent tool call that has not completed yet. */
  openTool: { name: string; readOnly: boolean; startedAt: string } | null;
}

export interface ExecutionActivity extends ExecutionActivityFacts {
  state: ExecutionActivityState;
  label: string;
  /** "warning" and "critical" are shown prominently with a next step. */
  attention: "none" | "warning" | "critical";
  /** Time since the latest confirmed activity (or the run start without any). */
  silentForMs: number | null;
  nextAction: string | null;
}

type ProjectionInput = Pick<ExecutionProjection, "phase" | "label" | "cause" | "nextAction">;

const ms = (value: string | null | undefined) => {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/** "45s", "12m", "3h 5m", "2d 4h". */
export function formatActivityDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

/**
 * Classify a run's current activity. Returns null for phases the projection
 * label already explains (queued, retry scheduled, terminal, recovery).
 */
export function classifyExecutionActivity(
  projection: ProjectionInput,
  facts: ExecutionActivityFacts | null | undefined,
  now: Date | number = Date.now(),
): ExecutionActivity | null {
  const nowMs = typeof now === "number" ? now : now.getTime();
  const base: ExecutionActivityFacts = facts ?? {
    source: "process_output",
    startedAt: null,
    lastConfirmedActivityAt: null,
    lastModelOutputAt: null,
    lastProgressAt: null,
    lastProgressSummary: null,
    openTool: null,
  };
  const startedMs = ms(base.startedAt);
  const activityMs = ms(base.lastConfirmedActivityAt) ?? startedMs;
  const silentForMs = activityMs == null ? null : Math.max(0, nowMs - activityMs);
  const make = (
    state: ExecutionActivityState,
    label: string,
    attention: ExecutionActivity["attention"] = "none",
    nextAction: string | null = projection.nextAction,
  ): ExecutionActivity => ({ ...base, state, label, attention, silentForMs, nextAction });

  switch (projection.phase) {
    case "waiting_for_answer":
    case "waiting_for_access":
    case "waiting_for_provider":
      return make("waiting_for_input", projection.label);
    case "finishing":
      return make("waiting_for_cleanup", projection.label === "Finishing" ? "Finishing and cleaning up" : projection.label);
    case "queued":
      return projection.cause === "previous_run_settling"
        ? make("waiting_for_cleanup", "Waiting for the previous run to clean up")
        : null;
    case "reconnecting": {
      if (silentForMs != null && silentForMs >= EXECUTION_ACTIVITY_RECONNECT_STALL_MS) {
        return make(
          "suspected_stall",
          "Possibly stalled",
          "critical",
          `Paperclip has not confirmed this run's agent process for ${formatActivityDuration(silentForMs)}, and the agent has sent nothing since. It may have stopped, for example after a server restart. Open the run to check it; if it is not running, stop it and retry, or comment on the task to continue.`,
        );
      }
      return make("reconnecting", projection.label === "Confirming execution" ? "Reconnecting" : projection.label);
    }
    case "working":
      break;
    default:
      return null;
  }

  if (silentForMs != null && silentForMs >= EXECUTION_ACTIVITY_STALL_MS) {
    return make(
      "suspected_stall",
      "Possibly stalled",
      "critical",
      `The agent has sent no output or tool activity for ${formatActivityDuration(silentForMs)}. Open the run to inspect its log; if it does not resume, stop it and retry, or comment on the task to wake the agent.`,
    );
  }
  const sinceStart = startedMs == null ? null : Math.max(0, nowMs - startedMs);
  if (!base.lastModelOutputAt && !base.openTool && sinceStart != null && sinceStart >= EXECUTION_ACTIVITY_NO_OUTPUT_MS) {
    return make(
      "no_progress",
      "No model output yet",
      "warning",
      `The run started ${formatActivityDuration(sinceStart)} ago and the model has produced no output. If this continues, stop the run and retry; if it repeats, check the agent's AI connection.`,
    );
  }
  // A non-read-only tool still running is the effective action in progress.
  const effectiveToolRunning = base.openTool != null && !base.openTool.readOnly;
  const progressMs = ms(base.lastProgressAt) ?? startedMs;
  const sinceProgress = progressMs == null ? null : Math.max(0, nowMs - progressMs);
  if (base.source === "provider_events" && !effectiveToolRunning && sinceProgress != null
      && sinceProgress >= EXECUTION_ACTIVITY_NO_PROGRESS_MS) {
    return make(
      "no_progress",
      "No effective action",
      "warning",
      `The agent is active but has not written a message, edited a file or run a command for ${formatActivityDuration(sinceProgress)}. Open the run to see what it is doing, or steer it with a comment.`,
    );
  }
  if (base.openTool) return make("running_tool", `Running ${base.openTool.name}`);
  if (!base.lastModelOutputAt) return make("waiting_for_model", "Waiting for model output");
  return make("generating", "Generating");
}
