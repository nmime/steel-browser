import { afterEach, describe, expect, it, vi } from "vitest";
import { FastifyReply, FastifyRequest } from "fastify";
import { InMemoryWorkerRegistry } from "./in-memory-worker-registry.js";
import { SchedulerService } from "./scheduler.service.js";
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
  endpoint: "http://worker-a:3000/",
  state: "ready",
  capacity: capacity(1),
  lastHeartbeatAt: new Date().toISOString(),
  ...overrides,
});

class FakeReply {
  statusCode = 200;
  headers: Record<string, string> = {};
  payload: unknown;

  code(statusCode: number) {
    this.statusCode = statusCode;
    return this;
  }

  header(key: string, value: string) {
    this.headers[key.toLowerCase()] = value;
    return this;
  }

  send(payload: unknown) {
    this.payload = payload;
    return this;
  }
}

const request = (overrides: Partial<FastifyRequest> = {}): FastifyRequest =>
  ({
    method: "POST",
    url: "/v1/sessions",
    raw: { url: "/v1/sessions" } as any,
    headers: { host: "scheduler.local" },
    body: {},
    ...overrides,
  }) as FastifyRequest;

describe("SchedulerService", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("allocates an idle worker and reserves one effective session slot", async () => {
    const registry = new InMemoryWorkerRegistry(30_000);
    const service = new SchedulerService(registry);
    await service.registerWorker(worker());

    const first = await service.allocate({ sessionId: "session-a" });
    const second = await service.allocate({ sessionId: "session-b" });

    expect(first).toMatchObject({
      status: "allocated",
      sessionId: "session-a",
      mapping: { workerId: "worker-a", endpoint: "http://worker-a:3000" },
    });
    expect(second).toMatchObject({ status: "unavailable" });
  });

  it("proxies session creation through the allocated worker and rewrites public URLs", async () => {
    const registry = new InMemoryWorkerRegistry(30_000);
    const service = new SchedulerService(registry);
    await service.registerWorker(worker());

    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({
          id: body.sessionId,
          status: "live",
          websocketUrl: "ws://worker-a:3000",
          debugUrl: "http://worker-a:3000/v1/sessions/debug",
          debuggerUrl: "http://worker-a:3000/v1/devtools/inspector.html",
          sessionViewerUrl: "http://worker-a:3000",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const reply = new FakeReply();
    await service.routeHttpRequest(
      request({ body: { sessionId: "session-a" } }),
      reply as unknown as FastifyReply,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://worker-a:3000/v1/sessions",
      expect.objectContaining({ method: "POST" }),
    );
    expect(service.getSessionMapping("session-a")).toMatchObject({ workerId: "worker-a" });
    expect(reply.statusCode).toBe(200);
    expect(reply.payload).toMatchObject({
      id: "session-a",
      websocketUrl: "ws://scheduler.local",
      debugUrl: "http://scheduler.local/v1/sessions/debug",
      sessionViewerUrl: "http://scheduler.local",
    });
  });

  it("routes session release to the mapped worker and removes the mapping after success", async () => {
    const registry = new InMemoryWorkerRegistry(30_000);
    const service = new SchedulerService(registry);
    await service.registerWorker(worker());
    await service.allocate({ sessionId: "session-a" });

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    const reply = new FakeReply();
    await service.routeHttpRequest(
      request({
        method: "POST",
        url: "/v1/sessions/session-a/release",
        raw: { url: "/v1/sessions/session-a/release" } as any,
      }),
      reply as unknown as FastifyReply,
    );

    expect(reply.payload).toMatchObject({ success: true });
    expect(service.getSessionMapping("session-a")).toBeUndefined();
  });

  it("can route a websocket by session query, header, or single active mapping", async () => {
    const registry = new InMemoryWorkerRegistry(30_000);
    const service = new SchedulerService(registry);
    await service.registerWorker(worker());
    await service.allocate({ sessionId: "session-a" });

    expect(service.findMappingForWebSocket("/v1/sessions/cast?sessionId=session-a")).toMatchObject({
      workerId: "worker-a",
    });
    expect(
      service.findMappingForWebSocket("/v1/sessions/cast", { "x-steel-session-id": "session-a" }),
    ).toMatchObject({
      workerId: "worker-a",
    });
    expect(service.findMappingForWebSocket("/v1/sessions/cast")).toMatchObject({
      workerId: "worker-a",
    });
  });

  it("marks sessions interrupted when their worker heartbeat becomes stale", async () => {
    const registry = new InMemoryWorkerRegistry(1_000);
    const service = new SchedulerService(registry);
    await service.registerWorker(worker({ lastHeartbeatAt: new Date().toISOString() }));
    await service.allocate({ sessionId: "session-a" });
    await registry.heartbeat(worker({ lastHeartbeatAt: "2026-01-01T00:00:00.000Z" }));

    const result = await service.recoverStaleWorkers(new Date("2026-01-01T00:00:02.000Z"));

    expect(result.staleWorkerIds).toEqual(["worker-a"]);
    expect(service.getSessionMapping("session-a")?.recovery).toMatchObject({
      state: "interrupted",
      sourceWorkerId: "worker-a",
      canRecover: false,
    });
    expect(service.getRecoveryEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "session_interrupted", sessionId: "session-a" }),
      ]),
    );
    expect(
      service.findMappingForWebSocket("/v1/sessions/cast?sessionId=session-a"),
    ).toBeUndefined();
  });

  it("recreates an interrupted session on a replacement worker when recovery auto-allocation is enabled", async () => {
    const registry = new InMemoryWorkerRegistry(1_000);
    const service = new SchedulerService(registry, {
      recoveryEnabled: true,
      recoveryAutoAllocate: true,
    });
    await service.registerWorker(
      worker({ id: "worker-a", lastHeartbeatAt: new Date().toISOString() }),
    );
    await service.registerWorker(
      worker({
        id: "worker-b",
        endpoint: "http://worker-b:3000/",
        lastHeartbeatAt: new Date().toISOString(),
      }),
    );

    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ id: body.sessionId, status: "live" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await service.routeCreateSession(
      request({ body: { sessionId: "session-a", profileId: "profile-a" } }),
      new FakeReply() as unknown as FastifyReply,
    );
    await registry.heartbeat(
      worker({ id: "worker-a", lastHeartbeatAt: "2026-01-01T00:00:00.000Z" }),
    );
    await registry.heartbeat(
      worker({
        id: "worker-b",
        endpoint: "http://worker-b:3000/",
        lastHeartbeatAt: "2026-01-01T00:00:01.500Z",
      }),
    );

    await service.recoverStaleWorkers(new Date("2026-01-01T00:00:02.000Z"));

    expect(service.getSessionMapping("session-a")).toMatchObject({
      workerId: "worker-b",
      recovery: {
        state: "recovered",
        sourceWorkerId: "worker-a",
        replacementWorkerId: "worker-b",
        restoredFrom: ["profile"],
      },
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://worker-a:3000/v1/sessions",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenLastCalledWith(
      "http://worker-b:3000/v1/sessions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "x-steel-session-recovery": "1" }),
      }),
    );
    expect(service.getRecoveryEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "session_recovered", sessionId: "session-a" }),
      ]),
    );
  });
});
