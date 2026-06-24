import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { InMemoryWorkerRegistry } from "./in-memory-worker-registry.js";
import { NoopWorkerAllocator } from "./noop-worker-allocator.js";
import { WorkerCapacity, WorkerRegistration } from "./types.js";

const capacity = (availableSessions: number): WorkerCapacity => ({
  maxSessions: 1,
  configuredMaxSessions: 1,
  activeSessions: 1 - availableSessions,
  availableSessions,
  acceptingSessions: availableSessions > 0,
  draining: false,
  idleBrowser: true,
});

const worker = (overrides: Partial<WorkerRegistration> = {}): WorkerRegistration => ({
  id: "worker-a",
  endpoint: "http://worker-a:3000",
  state: "ready",
  capacity: capacity(1),
  lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

describe("InMemoryWorkerRegistry", () => {
  it("registers, updates heartbeats, and marks workers draining", async () => {
    const registry = new InMemoryWorkerRegistry(30_000);

    await registry.register(worker({ metadata: { zone: "test" } }));
    await registry.heartbeat(worker({ capacity: capacity(0), metadata: { version: "v1" } }));

    expect(await registry.get("worker-a")).toMatchObject({
      id: "worker-a",
      capacity: { availableSessions: 0 },
      metadata: { zone: "test", version: "v1" },
    });

    expect(await registry.markDraining("worker-a")).toMatchObject({
      state: "draining",
      capacity: { acceptingSessions: false, draining: true },
    });
  });

  it("persists worker registry state when a store path is configured", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "steel-worker-registry-"));
    const storePath = path.join(dir, "workers.json");
    const registry = new InMemoryWorkerRegistry(30_000, storePath);

    await registry.register(worker({ id: "worker-persistent" }));

    const reloaded = new InMemoryWorkerRegistry(30_000, storePath);
    await expect(reloaded.get("worker-persistent")).resolves.toMatchObject({
      id: "worker-persistent",
      endpoint: "http://worker-a:3000",
    });
  });

  it("prunes stale workers", async () => {
    const registry = new InMemoryWorkerRegistry(1_000);
    await registry.register(worker({ lastHeartbeatAt: "2026-01-01T00:00:00.000Z" }));

    await expect(registry.pruneStale(new Date("2026-01-01T00:00:02.000Z"))).resolves.toEqual([
      "worker-a",
    ]);
    await expect(registry.list()).resolves.toEqual([]);
  });
});

describe("NoopWorkerAllocator", () => {
  it("selects the first ready worker with capacity", async () => {
    const registry = new InMemoryWorkerRegistry(30_000);
    await registry.register(
      worker({ id: "worker-b", capacity: capacity(0), lastHeartbeatAt: new Date().toISOString() }),
    );
    await registry.register(
      worker({ id: "worker-a", capacity: capacity(1), lastHeartbeatAt: new Date().toISOString() }),
    );

    await expect(new NoopWorkerAllocator(registry).allocate()).resolves.toMatchObject({
      status: "allocated",
      worker: { id: "worker-a" },
    });
  });

  it("returns noop without a registry", async () => {
    await expect(new NoopWorkerAllocator().allocate()).resolves.toMatchObject({ status: "noop" });
  });
});
