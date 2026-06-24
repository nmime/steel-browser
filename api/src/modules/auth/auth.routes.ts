import type { FastifyInstance, FastifyReply } from "fastify";
import { $ref } from "../../plugins/schemas.js";
import { redactSensitiveData } from "../../utils/redaction.js";
import type { CreateApiKeyRequest, LoginRequest } from "./auth.schema.js";
import { hasPermission, type Permission } from "./permissions.js";

async function routes(server: FastifyInstance) {
  server.post(
    "/auth/login",
    {
      schema: {
        operationId: "login",
        description:
          "Exchange local credentials for a Steel auth JWT when STEEL_AUTH_ENABLED is true.",
        tags: ["Auth"],
        body: $ref("Login"),
      },
    },
    async (request: LoginRequest, reply: FastifyReply) => {
      try {
        const result = server.authService.login(request.body.email, request.body.password);
        server.auditAuth({
          type: "auth.login",
          actorId: result.principal.id,
          method: "local",
          tenant: { tenantId: result.principal.tenantId, orgId: result.principal.orgId },
          status: "success",
          metadata: { email: request.body.email },
        });
        return reply.send({
          accessToken: result.accessToken,
          tokenType: "Bearer",
          expiresIn: result.expiresIn,
          principal: safePrincipal(result.principal),
        });
      } catch (error) {
        server.auditAuth({
          type: "auth.login",
          method: "local",
          status: "failure",
          reason: (error as Error).message,
          metadata: redactSensitiveData({ email: request.body?.email }),
        });
        throw error;
      }
    },
  );

  server.get("/auth/me", async (request, reply) =>
    reply.send({ principal: safePrincipal(request.auth), tenant: request.tenant }),
  );

  server.get("/auth/api-keys", async (request, reply) => {
    requireAuthPermission(request, "auth:manage");
    return reply.send({ apiKeys: server.authService.store.listApiKeys() });
  });

  server.post(
    "/auth/api-keys",
    {
      schema: {
        operationId: "create_api_key",
        description: "Create an API key. The raw key is returned once.",
        tags: ["Auth"],
        body: $ref("CreateApiKey"),
      },
    },
    async (request: CreateApiKeyRequest, reply: FastifyReply) => {
      requireAuthPermission(request, "auth:manage");
      const created = server.authService.store.createApiKey({
        ...request.body,
        permissions: request.body.permissions as any,
        tenantId: request.body.tenantId || request.tenant?.tenantId,
        orgId: request.body.orgId || request.tenant?.orgId,
      });
      server.auditAuth({
        type: "auth.api_key.create",
        actorId: request.auth?.id,
        tenant: request.tenant,
        method: request.auth?.method,
        status: "success",
        metadata: { keyId: created.record.id, subject: created.record.subject },
      });
      return reply.code(201).send(created);
    },
  );

  server.delete("/auth/api-keys/:id", async (request, reply) => {
    requireAuthPermission(request, "auth:manage");
    const id = (request.params as { id: string }).id;
    const revoked = server.authService.store.revokeApiKey(id);
    server.auditAuth({
      type: "auth.api_key.revoke",
      actorId: request.auth?.id,
      tenant: request.tenant,
      method: request.auth?.method,
      status: revoked ? "success" : "failure",
      metadata: { keyId: id },
    });
    return reply.code(revoked ? 204 : 404).send(revoked ? undefined : { error: "not_found" });
  });
}

function requireAuthPermission(request: any, permission: Permission) {
  if (!request.auth || !hasPermission(request.auth.permissions, permission)) {
    const error: Error & { statusCode?: number } = new Error("insufficient permissions");
    error.statusCode = 403;
    throw error;
  }
}

function safePrincipal(principal: any) {
  if (!principal) return null;
  const { keyId: _keyId, ...safe } = principal;
  return safe;
}

export default routes;
