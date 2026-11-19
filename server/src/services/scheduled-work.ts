import { readTaskDrain } from "./task-admission.js";
import { registerDeadlineWork } from "./deadline-work.js";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";

export function registerScheduledWork(
  coordinator: Pick<ReturnType<typeof createDeliveryWorkCoordinator>, "register">,
  options: {
    retryMs: number;
    tickAgentTimers: (signal: AbortSignal) => Promise<unknown>;
    nextAgentTimerAt: () => Promise<number | null>;
    tickIssueMonitors: (signal: AbortSignal) => Promise<unknown>;
    nextIssueMonitorAt: () => Promise<number | null>;
    tickRoutines: (signal: AbortSignal) => Promise<unknown>;
    nextRoutineRunAt: () => Promise<number | null>;
    canRun: () => boolean;
    /**
     * False keeps agent interval timers and scheduled routine triggers from
     * waking anything; issue monitors still fire at their saved deadlines.
     * Defaults to true.
     */
    timerWakeupsEnabled?: boolean;
  },
) {
  const timerWakeups = options.timerWakeupsEnabled !== false;
  // With timer wakeups off both queues stay registered, so commit notifications
  // and idle bookkeeping behave as usual, but they never read a deadline or
  // enqueue a run.
  const noDeadline = async () => null;
  const noRun = async () => undefined;
  const routines = registerDeadlineWork(coordinator, DELIVERY_QUEUES.routineSchedules, {
    run: timerWakeups ? options.tickRoutines : noRun,
    next: timerWakeups ? options.nextRoutineRunAt : noDeadline,
    canRun: options.canRun,
    retryMs: options.retryMs,
  });
  const monitors = registerDeadlineWork(coordinator, DELIVERY_QUEUES.issueMonitors, {
    run: options.tickIssueMonitors,
    next: options.nextIssueMonitorAt,
    canRun: () => options.canRun() && readTaskDrain(new Date()) === null,
    retryMs: options.retryMs,
    notificationCoalesceMs: options.retryMs,
  });
  const timers = registerDeadlineWork(coordinator, DELIVERY_QUEUES.agentTimers, {
    run: timerWakeups ? options.tickAgentTimers : noRun,
    next: timerWakeups ? options.nextAgentTimerAt : noDeadline,
    canRun: () => options.canRun() && readTaskDrain(new Date()) === null,
    retryMs: options.retryMs,
    notificationCoalesceMs: options.retryMs,
    minimumSpacingMs: options.retryMs,
  });
  return { routines, monitors, timers };
}
