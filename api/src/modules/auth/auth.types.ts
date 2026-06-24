import type { Permission } from "./permissions.js";

export type AuthMethod = "api_key" | "jwt" | "local";

export interface TenantContext {
  tenantId: string;
  orgId?: string;
  projectId?: string;
}

export interface AuthPrincipal {
  id: string;
  type: "user" | "service";
  subject: string;
  email?: string;
  roles: string[];
  permissions: Permission[];
  tenantId: string;
  orgId?: string;
  projectIds?: string[];
  method: AuthMethod;
  keyId?: string;
}

export interface LocalUserRecord {
  id: string;
  email: string;
  password?: string;
  passwordHash?: string;
  roles?: string[];
  permissions?: Permission[];
  tenantId?: string;
  orgId?: string;
  projectIds?: string[];
  disabled?: boolean;
}

export interface ApiKeyRecord {
  id: string;
  name?: string;
  keyHash: string;
  keyPrefix: string;
  subject: string;
  roles?: string[];
  permissions?: Permission[];
  tenantId?: string;
  orgId?: string;
  projectIds?: string[];
  createdAt: string;
  expiresAt?: string;
  revokedAt?: string;
}

export interface JwtClaims {
  sub: string;
  email?: string;
  roles?: string[];
  permissions?: Permission[];
  tenantId?: string;
  orgId?: string;
  projectIds?: string[];
  iat?: number;
  exp?: number;
  iss?: string;
  aud?: string;
}

export interface AuditEvent {
  type: string;
  actorId?: string;
  tenant?: TenantContext;
  method?: AuthMethod;
  path?: string;
  status?: "success" | "failure";
  reason?: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
}
