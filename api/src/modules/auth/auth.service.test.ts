import { describe, expect, it } from "vitest";
import { AuthService } from "./auth.service.js";
import { AuthStore } from "./auth.store.js";
import { signJwt } from "./crypto.js";

const apiKey = "sk_steel_test_service_key";

function buildService() {
  const store = AuthStore.fromEnv({
    STEEL_API_KEYS: JSON.stringify([
      {
        key: apiKey,
        id: "key_1",
        subject: "svc",
        roles: ["viewer"],
        tenantId: "tenant-a",
        orgId: "org-a",
        projectIds: ["project-a"],
      },
    ]),
    STEEL_AUTH_USERS: JSON.stringify([
      {
        id: "user_1",
        email: "admin@example.com",
        password: "pass",
        roles: ["admin"],
        tenantId: "tenant-a",
      },
    ]),
  });
  return new AuthService({ enabled: true, jwtSecret: "secret", store });
}

describe("AuthService", () => {
  it("authenticates API keys and builds tenant context", () => {
    const service = buildService();
    const principal = service.authenticateCredential(apiKey);
    const tenant = service.resolveTenant(principal, { "x-steel-project-id": "project-a" });

    expect(principal.subject).toBe("svc");
    expect(principal.method).toBe("api_key");
    expect(tenant).toEqual({ tenantId: "tenant-a", orgId: "org-a", projectId: "project-a" });
  });

  it("rejects tenant escalation", () => {
    const service = buildService();
    const principal = service.authenticateCredential(apiKey);
    expect(() => service.resolveTenant(principal, { "x-steel-tenant-id": "tenant-b" })).toThrow(
      "tenant is not allowed",
    );
  });

  it("issues and accepts local-auth JWTs", () => {
    const service = buildService();
    const login = service.login("admin@example.com", "pass");
    const principal = service.authenticateCredential(login.accessToken);

    expect(login.accessToken.split(".")).toHaveLength(3);
    expect(principal.email).toBe("admin@example.com");
    expect(principal.permissions).toContain("admin:*");
  });

  it("accepts external HS256 JWT primitives", () => {
    const service = buildService();
    const token = signJwt({ sub: "user_2", roles: ["viewer"], tenantId: "tenant-a" }, "secret", 60);
    expect(service.authenticateCredential(token)).toMatchObject({
      subject: "user_2",
      method: "jwt",
    });
  });
});
