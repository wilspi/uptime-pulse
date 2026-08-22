import type { MonitorStatus } from "../../shared/types";

export interface CurrentMonitorState {
  status: Exclude<MonitorStatus, "paused">;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  verificationStartedAt: number | null;
}

export interface NextMonitorState extends CurrentMonitorState {
  openedIncident: boolean;
  resolvedIncident: boolean;
}

const FAILURES_TO_DOWN = 3;
const SUCCESSES_TO_RECOVER = 2;

export function transitionMonitorState(
  current: CurrentMonitorState,
  successful: boolean,
  checkedAt: number,
): NextMonitorState {
  if (!successful) {
    const consecutiveFailures = Math.min(current.consecutiveFailures + 1, FAILURES_TO_DOWN);
    const verificationStartedAt = current.verificationStartedAt ?? checkedAt;
    const hasOpenIncident = current.status === "down" || current.status === "recovering";
    const status =
      hasOpenIncident || consecutiveFailures >= FAILURES_TO_DOWN ? "down" : "verifying";

    return {
      status,
      consecutiveFailures,
      consecutiveSuccesses: 0,
      verificationStartedAt,
      openedIncident: !hasOpenIncident && status === "down",
      resolvedIncident: false,
    };
  }

  if (current.status === "down" || current.status === "recovering") {
    const consecutiveSuccesses = current.consecutiveSuccesses + 1;
    const recovered = consecutiveSuccesses >= SUCCESSES_TO_RECOVER;

    return {
      status: recovered ? "up" : "recovering",
      consecutiveFailures: 0,
      consecutiveSuccesses,
      verificationStartedAt: recovered ? null : current.verificationStartedAt,
      openedIncident: false,
      resolvedIncident: recovered,
    };
  }

  return {
    status: "up",
    consecutiveFailures: 0,
    consecutiveSuccesses: Math.min(current.consecutiveSuccesses + 1, SUCCESSES_TO_RECOVER),
    verificationStartedAt: null,
    openedIncident: false,
    resolvedIncident: false,
  };
}
