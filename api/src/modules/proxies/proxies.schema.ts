import { FastifyRequest } from "fastify";
import { z } from "zod";

const ProxyHealth = z.object({
  status: z.enum(["unknown", "healthy", "unhealthy"]),
  checkedAt: z.string().datetime().optional(),
  message: z.string().optional(),
});

const ManagedProxy = z.object({
  id: z.string().uuid(),
  name: z.string().optional(),
  url: z.string(),
  status: z.enum(["active", "disabled"]),
  metadata: z.record(z.string(), z.any()),
  health: ProxyHealth,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

const ProxyMutation = z.object({
  id: z.string().uuid().optional(),
  name: z.string().optional(),
  url: z.string().optional(),
  status: z.enum(["active", "disabled"]).optional(),
  metadata: z.record(z.string(), z.any()).optional(),
});

const MultipleProxies = z.object({ proxies: z.array(ManagedProxy) });

const ProxyPool = z.object({
  id: z.string().uuid(),
  name: z.string().optional(),
  proxyIds: z.array(z.string().uuid()),
  strategy: z.enum(["round_robin", "least_leased", "random"]),
  metadata: z.record(z.string(), z.any()),
  cursor: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

const ProxyPoolMutation = z.object({
  id: z.string().uuid().optional(),
  name: z.string().optional(),
  proxyIds: z.array(z.string().uuid()).optional(),
  strategy: z.enum(["round_robin", "least_leased", "random"]).optional(),
  metadata: z.record(z.string(), z.any()).optional(),
});

const MultipleProxyPools = z.object({ proxyPools: z.array(ProxyPool) });

const ProxyLease = z.object({
  id: z.string().uuid(),
  proxyId: z.string().uuid(),
  poolId: z.string().uuid().optional(),
  sessionId: z.string().uuid().optional(),
  state: z.enum(["active", "released"]),
  ttlSeconds: z.number().int().min(1).optional(),
  expiresAt: z.string().datetime().optional(),
  createdAt: z.string().datetime(),
  releasedAt: z.string().datetime().optional(),
  proxy: ManagedProxy.optional(),
});

const ProxyLeaseRequest = z.object({
  poolId: z.string().uuid().optional(),
  proxyId: z.string().uuid().optional(),
  sessionId: z.string().uuid().optional(),
  ttlSeconds: z.number().int().min(1).optional(),
});

const MultipleProxyLeases = z.object({ proxyLeases: z.array(ProxyLease) });

const ProxyHealthCheck = z.object({
  proxyId: z.string().uuid(),
  status: z.enum(["unknown", "healthy", "unhealthy"]),
  checkedAt: z.string().datetime(),
  message: z.string(),
});

export type ProxyMutationBody = z.infer<typeof ProxyMutation>;
export type ProxyPoolMutationBody = z.infer<typeof ProxyPoolMutation>;
export type ProxyLeaseRequestBody = z.infer<typeof ProxyLeaseRequest>;
export type ProxyMutationRequest = FastifyRequest<{ Body: ProxyMutationBody }>;
export type ProxyParamsRequest = FastifyRequest<{ Params: { id: string } }>;
export type ProxyPoolMutationRequest = FastifyRequest<{ Body: ProxyPoolMutationBody }>;
export type ProxyPoolParamsRequest = FastifyRequest<{ Params: { id: string } }>;
export type ProxyLeaseMutationRequest = FastifyRequest<{ Body: ProxyLeaseRequestBody }>;
export type ProxyLeaseParamsRequest = FastifyRequest<{ Params: { id: string } }>;

export const proxySchemas = {
  ManagedProxy,
  ProxyMutation,
  MultipleProxies,
  ProxyPool,
  ProxyPoolMutation,
  MultipleProxyPools,
  ProxyLease,
  ProxyLeaseRequest,
  MultipleProxyLeases,
  ProxyHealthCheck,
};

export default proxySchemas;
