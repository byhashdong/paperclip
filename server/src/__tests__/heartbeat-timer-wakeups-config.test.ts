import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.ts";

// HEARTBEAT_TIMER_WAKEUPS_ENABLED splits timer-driven agent wakes (interval
// heartbeats and scheduled routine triggers) from the rest of the heartbeat
// scheduler (restart recovery, reconciliation, cleanup, issue monitors). Only
// an explicit "false" turns timer wakes off, so an unset variable keeps the
// upstream behaviour, and it does not change HEARTBEAT_SCHEDULER_ENABLED.
describe("heartbeat timer wakeups config parsing", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps timer wakeups on when the variable is not set", () => {
    vi.stubEnv("HEARTBEAT_TIMER_WAKEUPS_ENABLED", undefined);
    expect(loadConfig().heartbeatTimerWakeupsEnabled).toBe(true);
  });

  it("turns timer wakeups off only for an explicit false", () => {
    vi.stubEnv("HEARTBEAT_TIMER_WAKEUPS_ENABLED", "false");
    expect(loadConfig().heartbeatTimerWakeupsEnabled).toBe(false);
    for (const value of ["", "true", "0", "no"]) {
      vi.stubEnv("HEARTBEAT_TIMER_WAKEUPS_ENABLED", value);
      expect(loadConfig().heartbeatTimerWakeupsEnabled).toBe(true);
    }
  });

  it("is independent of the scheduler switch", () => {
    vi.stubEnv("HEARTBEAT_SCHEDULER_ENABLED", "true");
    vi.stubEnv("HEARTBEAT_TIMER_WAKEUPS_ENABLED", "false");
    const config = loadConfig();
    expect(config.heartbeatSchedulerEnabled).toBe(true);
    expect(config.heartbeatTimerWakeupsEnabled).toBe(false);
  });
});
