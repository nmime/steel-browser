import { describe, expect, it } from "vitest";
import {
  WorkerCapacityExceededError,
  WorkerDrainingError,
  WorkerRuntimeService,
} from "./worker-runtime.service.js";

describe("WorkerRuntimeService", () => {
  it("preserves standalone capacity semantics without rejecting sessions", () => {
    const runtime = new WorkerRuntimeService({ role: "standalone", maxSessions: 3 });

    expect(runtime.getCapacity({ status: "live" }).maxSessions).toBe(3);
    expect(() => runtime.assertCanStartSession({ status: "live" })).not.toThrow();
  });

  it("caps worker capacity to one active session", () => {
    const runtime = new WorkerRuntimeService({ role: "worker", maxSessions: 5 });

    expect(runtime.getCapacity({ status: "idle" })).toMatchObject({
      configuredMaxSessions: 5,
      maxSessions: 1,
      activeSessions: 0,
      availableSessions: 1,
      acceptingSessions: true,
    });

    expect(runtime.getCapacity({ status: "live" })).toMatchObject({
      activeSessions: 1,
      availableSessions: 0,
      acceptingSessions: false,
    });
    expect(() => runtime.assertCanStartSession({ status: "live" })).toThrow(
      WorkerCapacityExceededError,
    );
  });

  it("marks draining workers unavailable", () => {
    const runtime = new WorkerRuntimeService({ role: "worker", maxSessions: 1 });

    runtime.startDraining();

    expect(runtime.getHealth({ status: "idle" })).toMatchObject({
      status: "draining",
      capacity: { acceptingSessions: false, draining: true },
    });
    expect(() => runtime.assertCanStartSession({ status: "idle" })).toThrow(WorkerDrainingError);
  });
});
