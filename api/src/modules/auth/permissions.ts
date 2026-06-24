export const PERMISSIONS = [
  "auth:read",
  "auth:manage",
  "sessions:read",
  "sessions:manage",
  "actions:execute",
  "files:read",
  "files:manage",
  "logs:read",
  "logs:manage",
  "cdp:connect",
  "selenium:connect",
  "admin:*",
] as const;

export type Permission = (typeof PERMISSIONS)[number];
export type Role = "admin" | "developer" | "viewer" | "service";

const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  admin: ["admin:*"],
  developer: [
    "auth:read",
    "sessions:read",
    "sessions:manage",
    "actions:execute",
    "files:read",
    "files:manage",
    "logs:read",
    "cdp:connect",
    "selenium:connect",
  ],
  service: [
    "sessions:read",
    "sessions:manage",
    "actions:execute",
    "files:read",
    "files:manage",
    "cdp:connect",
    "selenium:connect",
  ],
  viewer: ["auth:read", "sessions:read", "files:read", "logs:read"],
};

export function permissionsForRoles(roles: readonly string[] = []): Permission[] {
  const permissions = new Set<Permission>();
  for (const role of roles) {
    for (const permission of ROLE_PERMISSIONS[role as Role] ?? []) permissions.add(permission);
  }
  return [...permissions];
}

export function hasPermission(granted: readonly string[] = [], permission: Permission): boolean {
  return granted.includes("admin:*") || granted.includes(permission);
}

export function permissionForRequest(method: string, pathname: string): Permission {
  if (pathname.startsWith("/v1/auth")) return method === "GET" ? "auth:read" : "auth:manage";
  if (pathname.startsWith("/v1/logs")) return method === "GET" ? "logs:read" : "logs:manage";
  if (pathname.includes("/files"))
    return method === "GET" || method === "HEAD" ? "files:read" : "files:manage";
  if (
    pathname.startsWith("/v1/scrape") ||
    pathname.startsWith("/v1/screenshot") ||
    pathname.startsWith("/v1/pdf") ||
    pathname.startsWith("/v1/search") ||
    pathname.startsWith("/v1/events")
  )
    return "actions:execute";
  if (pathname.startsWith("/v1/devtools")) return "cdp:connect";
  if (
    pathname.startsWith("/json") ||
    pathname.startsWith("/session") ||
    pathname.startsWith("/wd") ||
    pathname.startsWith("/selenium")
  )
    return "selenium:connect";
  return method === "GET" || method === "HEAD" ? "sessions:read" : "sessions:manage";
}
