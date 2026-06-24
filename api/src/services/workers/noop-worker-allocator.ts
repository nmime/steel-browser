import {
  WorkerAllocationRequest,
  WorkerAllocationResult,
  WorkerAllocator,
  WorkerRegistry,
} from "./types.js";

export class NoopWorkerAllocator implements WorkerAllocator {
  constructor(private readonly registry?: WorkerRegistry) {}

  async allocate(_request?: WorkerAllocationRequest): Promise<WorkerAllocationResult> {
    if (!this.registry) {
      return {
        status: "noop",
        reason: "Scheduler allocation is a skeleton; no remote worker dispatch is configured.",
      };
    }

    await this.registry.pruneStale();
    const workers = await this.registry.list();
    const worker = workers.find(
      (candidate) =>
        candidate.state === "ready" &&
        candidate.capacity.acceptingSessions &&
        candidate.capacity.availableSessions > 0,
    );

    if (!worker) {
      return {
        status: "unavailable",
        reason: "No registered worker currently has available capacity.",
      };
    }

    return {
      status: "allocated",
      worker,
      reason: "Selected an available worker; session forwarding is not implemented yet.",
    };
  }
}
