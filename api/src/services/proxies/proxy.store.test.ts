import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProxyStore } from "./proxy.store.js";

let tmpDirs: string[] = [];

async function tempStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "steel-proxies-"));
  tmpDirs.push(dir);
  return {
    dir,
    filePath: path.join(dir, "proxies.json"),
  };
}

afterEach(async () => {
  await Promise.all(tmpDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tmpDirs = [];
});

describe("ProxyStore", () => {
  it("redacts inventory responses while persisting BYOP proxy URLs", async () => {
    const { filePath } = await tempStore();
    const store = new ProxyStore({ filePath });

    const proxy = await store.upsertProxy({
      name: "residential-1",
      url: "proxy-user:proxy-pass@example.com:8080",
      metadata: { owner: "network", token: "secret" },
    });

    expect(proxy.url).toBe("http://redacted:redacted@example.com:8080");
    expect(proxy.metadata.token).toBe("[REDACTED]");

    const persisted = await readFile(filePath, "utf8");
    expect(persisted).toContain("proxy-user");
    expect(persisted).toContain("proxy-pass");
  });

  it("allocates leases from pools using round-robin and releases by session", async () => {
    const store = new ProxyStore();
    const first = await store.upsertProxy({ url: "http://one.example:8000" });
    const second = await store.upsertProxy({ url: "http://two.example:8000" });
    const pool = await store.upsertPool({
      proxyIds: [first.id, second.id],
      strategy: "round_robin",
    });

    const leaseA = await store.acquireLease({
      poolId: pool.id,
      sessionId: "00000000-0000-0000-0000-000000000001",
    });
    const leaseB = await store.acquireLease({
      poolId: pool.id,
      sessionId: "00000000-0000-0000-0000-000000000001",
    });

    expect(leaseA.proxyId).toBe(first.id);
    expect(leaseB.proxyId).toBe(second.id);

    const released = await store.releaseLeasesForSession("00000000-0000-0000-0000-000000000001");
    expect(released).toHaveLength(2);
    expect((await store.getLease(leaseA.id))?.state).toBe("released");
  });

  it("records health-check stubs without active network probing", async () => {
    const store = new ProxyStore();
    const proxy = await store.upsertProxy({ url: "http://health.example:8000" });

    const checked = await store.healthCheckProxy(proxy.id);

    expect(checked?.health.status).toBe("unknown");
    expect(checked?.health.message).toContain("stub");
  });
});
