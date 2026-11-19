import {
  classifyExecutionActivity,
  formatActivityDuration,
  type ExecutionActivity,
  type ExecutionProjection,
} from "@paperclipai/shared";
import { CircleAlert, TriangleAlert } from "lucide-react";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";
import { useSecondTick } from "@/hooks/useSecondTick";
import { isTerminalRunStatus } from "./transcript-adapter";

/**
 * The run's current activity, re-classified against the clock every second.
 * The server sends the provider evidence with the projection; a silent run
 * sends nothing new, so the board escalates it locally with the same rules.
 */
export function useLiveExecutionActivity(
  execution: ExecutionProjection | null | undefined,
  status: string,
): ExecutionActivity | null {
  const live = !!execution?.activity && !isTerminalRunStatus(status);
  useSecondTick(live);
  if (!live || !execution?.activity) return null;
  return classifyExecutionActivity(execution, execution.activity, Date.now());
}

function ago(value: string | null, nowMs: number): string | null {
  if (!value) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? `${formatActivityDuration(Math.max(0, nowMs - at))} ago` : null;
}

function exact(value: string | null): string | undefined {
  return value ? new Date(value).toLocaleString() : undefined;
}

/** "Last activity 2m ago · Last progress 4m ago: Ran Bash · pnpm test". */
export function RunActivityDetails({ activity, className }: { activity: ExecutionActivity; className?: string }) {
  const nowMs = Date.now();
  const activityAgo = ago(activity.lastConfirmedActivityAt, nowMs);
  const progressAgo = ago(activity.lastProgressAt, nowMs);
  return (
    <div
      className={cn("flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground", className)}
      data-testid="run-activity-details"
      data-activity-state={activity.state}
    >
      <span title={exact(activity.lastConfirmedActivityAt)} data-testid="run-activity-last-activity">
        {activityAgo ? `Last activity ${activityAgo}` : "No agent activity yet"}
      </span>
      {activity.source === "provider_events" ? (
        <>
          <span aria-hidden="true">·</span>
          <span className="min-w-0 truncate" title={exact(activity.lastProgressAt)} data-testid="run-activity-last-progress">
            {activity.lastProgressSummary && progressAgo
              ? `Last progress ${progressAgo}: ${activity.lastProgressSummary}`
              : "No effective action yet"}
          </span>
        </>
      ) : null}
    </div>
  );
}

/** Prominent notice for no effective action or a suspected stall, with the next step. */
export function RunActivityAlert({
  activity,
  runHref,
  className,
}: {
  activity: ExecutionActivity;
  runHref?: string | null;
  className?: string;
}) {
  if (activity.attention === "none") return null;
  const critical = activity.attention === "critical";
  const Icon = critical ? CircleAlert : TriangleAlert;
  return (
    <div
      role="alert"
      className={cn(
        "my-1 flex min-w-0 items-start gap-2 rounded-md border px-3 py-2 text-xs text-foreground",
        critical ? "border-destructive/40 bg-destructive/10" : "border-amber-500/40 bg-amber-500/10",
        className,
      )}
      data-testid="run-activity-alert"
      data-activity-state={activity.state}
    >
      <Icon className={cn("mt-0.5 size-3.5 shrink-0", critical ? "text-destructive" : "text-amber-600 dark:text-amber-400")} aria-hidden="true" />
      <div className="flex min-w-0 flex-col gap-1">
        <span className="font-medium">{activity.label}</span>
        {activity.nextAction ? <span className="text-muted-foreground">{activity.nextAction}</span> : null}
        {runHref ? (
          <Link to={runHref} className="w-fit font-medium underline underline-offset-2" data-testid="run-activity-open-run">
            Open run
          </Link>
        ) : null}
      </div>
    </div>
  );
}

/** Details line and, when needed, the alert, for a live run. */
export function RunActivityStatus({
  execution,
  status,
  runHref,
  className,
}: {
  execution: ExecutionProjection | null | undefined;
  status: string;
  runHref?: string | null;
  className?: string;
}) {
  const activity = useLiveExecutionActivity(execution, status);
  if (!activity) return null;
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)} data-testid="run-activity-status">
      <RunActivityDetails activity={activity} />
      <RunActivityAlert activity={activity} runHref={runHref} />
    </div>
  );
}
