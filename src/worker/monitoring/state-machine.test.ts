import { describe, expect, it } from "vitest";
import type { CurrentMonitorState } from "./state-machine";
import { transitionMonitorState } from "./state-machine";

const initial: CurrentMonitorState = {
  status: "up",
  consecutiveFailures: 0,
  consecutiveSuccesses: 2,
  verificationStartedAt: null,
};

describe("transitionMonitorState", () => {
  it("requires three consecutive failures before opening an incident", () => {
    const first = transitionMonitorState(initial, false, 100);
    const second = transitionMonitorState(first, false, 160);
    const third = transitionMonitorState(second, false, 220);

    expect(first).toMatchObject({ status: "verifying", consecutiveFailures: 1, openedIncident: false });
    expect(second).toMatchObject({ status: "verifying", consecutiveFailures: 2, openedIncident: false });
    expect(third).toMatchObject({ status: "down", consecutiveFailures: 3, openedIncident: true, verificationStartedAt: 100 });
  });

  it("requires two consecutive successes before resolving an incident", () => {
    const down: CurrentMonitorState = {
      status: "down",
      consecutiveFailures: 3,
      consecutiveSuccesses: 0,
      verificationStartedAt: 100,
    };
    const first = transitionMonitorState(down, true, 280);
    const second = transitionMonitorState(first, true, 340);

    expect(first).toMatchObject({ status: "recovering", resolvedIncident: false });
    expect(second).toMatchObject({ status: "up", resolvedIncident: true, verificationStartedAt: null });
  });

  it("returns directly to down if a recovery check fails", () => {
    const recovering: CurrentMonitorState = {
      status: "recovering",
      consecutiveFailures: 0,
      consecutiveSuccesses: 1,
      verificationStartedAt: 100,
    };

    expect(transitionMonitorState(recovering, false, 340)).toMatchObject({
      status: "down",
      openedIncident: false,
      resolvedIncident: false,
    });
  });

  it("clears a transient failure after one success", () => {
    const verifying = transitionMonitorState(initial, false, 100);
    expect(transitionMonitorState(verifying, true, 160)).toMatchObject({
      status: "up",
      consecutiveFailures: 0,
      openedIncident: false,
    });
  });
});
