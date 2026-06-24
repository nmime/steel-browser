import type { FastifyRequest } from "fastify";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import type {
  ApiKeyRecord,
  AuthMethod,
  AuthPrincipal,
  JwtClaims,
  LocalUserRecord,
  TenantContext,
} from "./auth.types.js";
import { AuthStore } from "./auth.store.js";
import { permissionsForRoles, type Permission } from "./permissions.js";
import { signJwt, verifyJwt, verifyPassword } from "./crypto.js";

export interface AuthServiceOptions {
  enabled: boolean;
  jwtSecret?: string;
  jwtTtlSeconds?: number;
  defaultTenantId?: string;
  store?: AuthStore;
}

export interface AuthenticationResult {
  principal: AuthPrincipal;
  tenant: TenantContext;
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly statusCode = 401,
  ) {
    super(message);
  }
}

export class AuthService {
  readonly store: AuthStore;
  private readonly jwtTtlSeconds: number;
  private readonly defaultTenantId: string;

  constructor(private readonly options: AuthServiceOptions) {
    this.store = options.store || new AuthStore();
    this.jwtTtlSeconds = options.jwtTtlSeconds || 3600;
    this.defaultTenantId = options.defaultTenantId || "default";
  }

  get enabled(): boolean {
    return this.options.enabled;
  }

  async authenticateRequest(request: FastifyRequest): Promise<AuthenticationResult> {
    const token = extractCredential(request.headers, request.url);
    if (!token) throw new AuthError("missing credentials");
    const principal = this.authenticateCredential(token);
    return { principal, tenant: this.resolveTenant(principal, request.headers) };
  }

  async authenticateUpgrade(request: IncomingMessage): Promise<AuthenticationResult> {
    const token = extractCredential(request.headers, request.url || "/");
    if (!token) throw new AuthError("missing websocket credentials");
    const principal = this.authenticateCredential(token);
    return { principal, tenant: this.resolveTenant(principal, request.headers) };
  }

  authenticateCredential(token: string): AuthPrincipal {
    const apiKey = this.store.findApiKey(token);
    if (apiKey) return principalFromApiKey(apiKey, this.defaultTenantId);
    if (token.includes(".") && this.options.jwtSecret) {
      return principalFromClaims(
        verifyJwt(token, this.options.jwtSecret),
        "jwt",
        this.defaultTenantId,
      );
    }
    throw new AuthError("invalid credentials");
  }

  login(
    email: string,
    password: string,
  ): { accessToken: string; principal: AuthPrincipal; expiresIn: number } {
    if (!this.options.jwtSecret)
      throw new AuthError("local auth requires STEEL_AUTH_JWT_SECRET", 503);
    const user = this.store.findUserByEmail(email);
    if (!user || user.disabled || !verifyPassword(password, user.password, user.passwordHash)) {
      throw new AuthError("invalid email or password");
    }
    const principal = principalFromUser(user, this.defaultTenantId);
    const accessToken = signJwt(
      {
        sub: principal.subject,
        email: principal.email,
        roles: principal.roles,
        permissions: principal.permissions,
        tenantId: principal.tenantId,
        orgId: principal.orgId,
        projectIds: principal.projectIds,
      },
      this.options.jwtSecret,
      this.jwtTtlSeconds,
    );
    return { accessToken, principal, expiresIn: this.jwtTtlSeconds };
  }

  resolveTenant(principal: AuthPrincipal, headers: IncomingHttpHeaders): TenantContext {
    const tenantId =
      firstHeader(headers["x-steel-tenant-id"]) || principal.tenantId || this.defaultTenantId;
    const orgId = firstHeader(headers["x-steel-org-id"]) || principal.orgId;
    const projectId = firstHeader(headers["x-steel-project-id"]);
    if (principal.tenantId && tenantId !== principal.tenantId)
      throw new AuthError("tenant is not allowed", 403);
    if (principal.orgId && orgId && orgId !== principal.orgId)
      throw new AuthError("org is not allowed", 403);
    if (projectId && principal.projectIds?.length && !principal.projectIds.includes(projectId))
      throw new AuthError("project is not allowed", 403);
    return { tenantId, orgId, projectId };
  }
}

function principalFromApiKey(record: ApiKeyRecord, defaultTenantId: string): AuthPrincipal {
  const roles = record.roles || ["service"];
  return {
    id: record.id,
    type: "service",
    subject: record.subject,
    roles,
    permissions: mergePermissions(roles, record.permissions),
    tenantId: record.tenantId || defaultTenantId,
    orgId: record.orgId,
    projectIds: record.projectIds,
    method: "api_key",
    keyId: record.id,
  };
}

function principalFromUser(user: LocalUserRecord, defaultTenantId: string): AuthPrincipal {
  const roles = user.roles || ["viewer"];
  return {
    id: user.id,
    type: "user",
    subject: user.id,
    email: user.email,
    roles,
    permissions: mergePermissions(roles, user.permissions),
    tenantId: user.tenantId || defaultTenantId,
    orgId: user.orgId,
    projectIds: user.projectIds,
    method: "local",
  };
}

function principalFromClaims(
  claims: JwtClaims,
  method: AuthMethod,
  defaultTenantId: string,
): AuthPrincipal {
  const roles = claims.roles || ["viewer"];
  return {
    id: claims.sub,
    type: "user",
    subject: claims.sub,
    email: claims.email,
    roles,
    permissions: mergePermissions(roles, claims.permissions),
    tenantId: claims.tenantId || defaultTenantId,
    orgId: claims.orgId,
    projectIds: claims.projectIds,
    method,
  };
}

function mergePermissions(roles: string[], explicit: Permission[] = []): Permission[] {
  return [...new Set([...permissionsForRoles(roles), ...explicit])];
}

function extractCredential(headers: IncomingHttpHeaders, url?: string): string | undefined {
  const apiKeyHeader = firstHeader(headers["x-api-key"]);
  if (apiKeyHeader) return apiKeyHeader.trim();
  const authHeader = firstHeader(headers.authorization);
  if (authHeader) {
    const [scheme, ...rest] = authHeader.split(" ");
    if (["bearer", "apikey", "api-key"].includes(scheme.toLowerCase()))
      return rest.join(" ").trim();
    return authHeader.trim();
  }
  if (!url) return undefined;
  const parsed = new URL(url, "http://steel.local");
  return (
    parsed.searchParams.get("apiKey") ||
    parsed.searchParams.get("api_key") ||
    parsed.searchParams.get("token") ||
    undefined
  );
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
