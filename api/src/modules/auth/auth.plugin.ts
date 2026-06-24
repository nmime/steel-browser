import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { env } from "../../env.js";
import { redactSensitiveData, redactUrl } from "../../utils/redaction.js";
import type { AuditEvent, AuthPrincipal, TenantContext } from "./auth.types.js";
import { AuthError, AuthService } from "./auth.service.js";
import { AuthStore } from "./auth.store.js";
import { hasPermission, permissionForRequest } from "./permissions.js";
import { resolveMetadataFilePath } from "../../services/metadata/index.js";

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthPrincipal;
    tenant?: TenantContext;
  }
  interface FastifyInstance {
    authService: AuthService;
    auditAuth: (event: Omit<AuditEvent, "timestamp">) => void;
    authenticateWebSocket: (request: IncomingMessage, socket?: Duplex) => Promise<boolean>;
  }
}

const authPlugin: FastifyPluginAsync = async (fastify) => {
  const authService = new AuthService({
    enabled: env.STEEL_AUTH_ENABLED,
    jwtSecret: env.STEEL_AUTH_JWT_SECRET,
    jwtTtlSeconds: env.STEEL_AUTH_JWT_TTL_SECONDS,
    defaultTenantId: env.STEEL_DEFAULT_TENANT_ID,
    store: AuthStore.fromEnv(
      process.env,
      resolveMetadataFilePath("auth", env.STEEL_AUTH_STORE_PATH, env.STEEL_METADATA_STORE_PATH),
    ),
  });

  fastify.decorate("authService", authService);
  fastify.decorate("auditAuth", (event: Omit<AuditEvent, "timestamp">) => {
    const auditEvent = {
      ...redactSensitiveData(event),
      timestamp: new Date().toISOString(),
    } as AuditEvent;
    authService.store.appendAudit(auditEvent);
    fastify.log.info(auditEvent, "auth audit");
  });
  fastify.decorate("authenticateWebSocket", async (request: IncomingMessage, socket?: Duplex) => {
    if (!authService.enabled) return true;
    try {
      const result = await authService.authenticateUpgrade(request);
      (request as IncomingMessage & { auth?: AuthPrincipal; tenant?: TenantContext }).auth =
        result.principal;
      (request as IncomingMessage & { auth?: AuthPrincipal; tenant?: TenantContext }).tenant =
        result.tenant;
      fastify.auditAuth({
        type: "auth.websocket",
        actorId: result.principal.id,
        tenant: result.tenant,
        method: result.principal.method,
        path: request.url ? redactUrl(request.url) : undefined,
        status: "success",
      });
      return true;
    } catch (error) {
      fastify.auditAuth({
        type: "auth.websocket",
        path: request.url ? redactUrl(request.url) : undefined,
        status: "failure",
        reason: (error as Error).message,
      });
      socket?.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket?.destroy();
      return false;
    }
  });

  fastify.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!authService.enabled) return;
    const pathname = getPathname(request.raw.url || request.url);
    if (isPublicRoute(request.method, pathname)) return;

    try {
      const result = await authService.authenticateRequest(request);
      const requiredPermission = permissionForRequest(request.method, pathname);
      if (!hasPermission(result.principal.permissions, requiredPermission))
        throw new AuthError("insufficient permissions", 403);
      request.auth = result.principal;
      request.tenant = result.tenant;
      fastify.auditAuth({
        type: "auth.request",
        actorId: result.principal.id,
        tenant: result.tenant,
        method: result.principal.method,
        path: redactUrl(request.raw.url || request.url),
        status: "success",
        metadata: { permission: requiredPermission },
      });
    } catch (error) {
      const authError = error as Error & { statusCode?: number };
      fastify.auditAuth({
        type: "auth.request",
        path: redactUrl(request.raw.url || request.url),
        status: "failure",
        reason: authError.message,
      });
      return reply.code(authError.statusCode || 401).send({
        error: authError.statusCode === 403 ? "forbidden" : "unauthorized",
        message: authError.message,
      });
    }
  });
};

export function isPublicRoute(method: string, pathname: string): boolean {
  if (method === "OPTIONS") return true;
  if (pathname === "/" || pathname === "/status" || pathname === "/v1/health") return true;
  if (pathname === "/v1/auth/login") return true;
  if (pathname.startsWith("/documentation")) return true;
  if (pathname.startsWith("/ui")) return true;
  return false;
}

function getPathname(url: string): string {
  return new URL(url, "http://steel.local").pathname;
}

export default fp(authPlugin, { name: "auth" });
