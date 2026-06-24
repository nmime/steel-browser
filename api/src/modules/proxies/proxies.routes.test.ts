import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

let tmpDirs: string[] = [];

async function buildApp() {
  vi.resetModules();
  const dir = await mkdtemp(path.join(os.tmpdir(), "steel-proxy-routes-"));
  tmpDirs.push(dir);
  vi.stubEnv("STEEL_PROXY_STORE_PATH", path.join(dir, "proxies.json"));

  const [{ default: openAPIPlugin }, { default: proxiesRoutes }] = await Promise.all([
    import("../../plugins/schemas.js"),
    import("./proxies.routes.js"),
  ]);
  const app = Fastify({ logger: false });
  await app.register(openAPIPlugin);
  await app.register(proxiesRoutes, { prefix: "/v1" });
  await app.ready();
  return app;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tmpDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tmpDirs = [];
});

describe("proxy management routes", () => {
  it("creates redacted proxies, pools, leases, and health stubs", async () => {
    const app = await buildApp();

    const createdProxy = await app.inject({
      method: "POST",
      url: "/v1/proxies",
      payload: { url: "user:pass@proxy.example:8080", metadata: { token: "secret" } },
    });
    expect(createdProxy.statusCode).toBe(200);
    const proxy = createdProxy.json();
    expect(proxy.url).toBe("http://redacted:redacted@proxy.example:8080");
    expect(proxy.metadata.token).toBe("[REDACTED]");

    const createdPool = await app.inject({
      method: "POST",
      url: "/v1/proxy-pools",
      payload: { proxyIds: [proxy.id], strategy: "least_leased" },
    });
    expect(createdPool.statusCode).toBe(200);
    const pool = createdPool.json();

    const leaseResponse = await app.inject({
      method: "POST",
      url: "/v1/proxy-leases",
      payload: { poolId: pool.id },
    });
    expect(leaseResponse.statusCode).toBe(200);
    const lease = leaseResponse.json();
    expect(lease.proxyId).toBe(proxy.id);
    expect(lease.proxy.url).toBe("http://redacted:redacted@proxy.example:8080");

    const released = await app.inject({
      method: "POST",
      url: `/v1/proxy-leases/${lease.id}/release`,
    });
    expect(released.statusCode).toBe(200);
    expect(released.json().state).toBe("released");

    const health = await app.inject({ method: "POST", url: `/v1/proxies/${proxy.id}/health` });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ proxyId: proxy.id, status: "unknown" });

    await app.close();
  });
});
