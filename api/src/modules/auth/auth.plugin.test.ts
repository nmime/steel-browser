import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

async function buildApp(authEnabled: boolean) {
  vi.resetModules();
  vi.stubEnv("STEEL_AUTH_ENABLED", authEnabled ? "true" : "false");
  vi.stubEnv("STEEL_DEFAULT_TENANT_ID", "tenant-a");
  vi.stubEnv(
    "STEEL_API_KEYS",
    JSON.stringify([
      {
        key: "sk_steel_viewer",
        id: "viewer-key",
        subject: "viewer",
        roles: ["viewer"],
        tenantId: "tenant-a",
      },
      {
        key: "sk_steel_admin",
        id: "admin-key",
        subject: "admin",
        roles: ["admin"],
        tenantId: "tenant-a",
      },
    ]),
  );
  const { default: authPlugin } = await import("./auth.plugin.js");
  const app = Fastify({ logger: false });
  await app.register(authPlugin);
  app.get("/v1/sessions", async (request) => ({
    auth: request.auth?.subject ?? null,
    tenant: request.tenant ?? null,
  }));
  app.post("/v1/sessions", async () => ({ ok: true }));
  await app.ready();
  return app;
}

afterEach(() => vi.unstubAllEnvs());

describe("auth plugin route protection", () => {
  it("preserves unauthenticated compatibility when STEEL_AUTH_ENABLED is false", async () => {
    const app = await buildApp(false);
    const response = await app.inject({ method: "GET", url: "/v1/sessions" });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ auth: null, tenant: null });
  });

  it("rejects protected routes without credentials when enabled", async () => {
    const app = await buildApp(true);
    const response = await app.inject({ method: "GET", url: "/v1/sessions" });
    await app.close();

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: "unauthorized" });
  });

  it("attaches tenant context for valid API keys", async () => {
    const app = await buildApp(true);
    const response = await app.inject({
      method: "GET",
      url: "/v1/sessions",
      headers: { "x-api-key": "sk_steel_viewer", "x-steel-project-id": "project-1" },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      auth: "viewer",
      tenant: { tenantId: "tenant-a", projectId: "project-1" },
    });
  });

  it("enforces RBAC permissions", async () => {
    const app = await buildApp(true);
    const viewer = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { "x-api-key": "sk_steel_viewer" },
    });
    const admin = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { "x-api-key": "sk_steel_admin" },
    });
    await app.close();

    expect(viewer.statusCode).toBe(403);
    expect(admin.statusCode).toBe(200);
  });
});
