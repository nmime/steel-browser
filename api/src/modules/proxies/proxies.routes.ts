import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { $ref } from "../../plugins/schemas.js";
import { managedProxyStore, ProxyStoreError } from "../../services/proxies/proxy.store.js";
import {
  ProxyLeaseMutationRequest,
  ProxyLeaseParamsRequest,
  ProxyMutationRequest,
  ProxyParamsRequest,
  ProxyPoolMutationRequest,
  ProxyPoolParamsRequest,
} from "./proxies.schema.js";

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof ProxyStoreError) {
    return reply.code(error.statusCode).send({ message: error.message });
  }
  throw error;
}

async function routes(server: FastifyInstance) {
  server.get(
    "/proxies",
    {
      schema: {
        operationId: "list_proxies",
        description: "List BYOP proxy inventory with credentials redacted.",
        tags: ["Proxies"],
        response: { 200: $ref("MultipleProxies") },
      },
    },
    async () => ({ proxies: await managedProxyStore.listProxies() }),
  );

  server.post(
    "/proxies",
    {
      schema: {
        operationId: "upsert_proxy",
        description:
          "Create or update a BYOP proxy inventory item. Proxy procurement is intentionally not implemented.",
        tags: ["Proxies"],
        body: $ref("ProxyMutation"),
        response: { 200: $ref("ManagedProxy") },
      },
    },
    async (request: ProxyMutationRequest, reply: FastifyReply) => {
      try {
        return await managedProxyStore.upsertProxy(request.body);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  server.get(
    "/proxies/:id",
    {
      schema: {
        operationId: "get_proxy",
        description: "Get a BYOP proxy inventory item with credentials redacted.",
        tags: ["Proxies"],
        response: { 200: $ref("ManagedProxy") },
      },
    },
    async (request: ProxyParamsRequest, reply: FastifyReply) => {
      const proxy = await managedProxyStore.getProxy(request.params.id);
      return proxy ?? reply.code(404).send({ message: "Proxy not found" });
    },
  );

  server.patch(
    "/proxies/:id",
    {
      schema: {
        operationId: "update_proxy",
        description: "Update BYOP proxy metadata, status, or URL.",
        tags: ["Proxies"],
        body: $ref("ProxyMutation"),
        response: { 200: $ref("ManagedProxy") },
      },
    },
    async (
      request: FastifyRequest<{ Params: { id: string }; Body: ProxyMutationRequest["body"] }>,
      reply: FastifyReply,
    ) => {
      try {
        return await managedProxyStore.upsertProxy({ ...request.body, id: request.params.id });
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  server.delete(
    "/proxies/:id",
    {
      schema: {
        operationId: "delete_proxy",
        description: "Delete a BYOP proxy inventory item when it has no active leases.",
        tags: ["Proxies"],
        response: { 204: { type: "null", description: "No content" } },
      },
    },
    async (request: ProxyParamsRequest, reply: FastifyReply) => {
      try {
        const deleted = await managedProxyStore.deleteProxy(request.params.id);
        return deleted
          ? reply.code(204).send()
          : reply.code(404).send({ message: "Proxy not found" });
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  server.post(
    "/proxies/:id/health",
    {
      schema: {
        operationId: "check_proxy_health",
        description:
          "Record a managed proxy health-check stub. This does not perform active network probing yet.",
        tags: ["Proxies"],
        response: { 200: $ref("ProxyHealthCheck") },
      },
    },
    async (request: ProxyParamsRequest, reply: FastifyReply) => {
      const proxy = await managedProxyStore.healthCheckProxy(request.params.id);
      return proxy
        ? reply.send({ proxyId: proxy.id, ...proxy.health })
        : reply.code(404).send({ message: "Proxy not found" });
    },
  );

  server.get(
    "/proxy-pools",
    {
      schema: {
        operationId: "list_proxy_pools",
        description: "List managed proxy pools.",
        tags: ["Proxy Pools"],
        response: { 200: $ref("MultipleProxyPools") },
      },
    },
    async () => ({ proxyPools: await managedProxyStore.listPools() }),
  );

  server.post(
    "/proxy-pools",
    {
      schema: {
        operationId: "upsert_proxy_pool",
        description: "Create or update a managed proxy pool and allocation strategy.",
        tags: ["Proxy Pools"],
        body: $ref("ProxyPoolMutation"),
        response: { 200: $ref("ProxyPool") },
      },
    },
    async (request: ProxyPoolMutationRequest, reply: FastifyReply) => {
      try {
        return await managedProxyStore.upsertPool(request.body);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  server.get(
    "/proxy-pools/:id",
    {
      schema: {
        operationId: "get_proxy_pool",
        description: "Get a managed proxy pool.",
        tags: ["Proxy Pools"],
        response: { 200: $ref("ProxyPool") },
      },
    },
    async (request: ProxyPoolParamsRequest, reply: FastifyReply) => {
      const pool = await managedProxyStore.getPool(request.params.id);
      return pool ?? reply.code(404).send({ message: "Proxy pool not found" });
    },
  );

  server.patch(
    "/proxy-pools/:id",
    {
      schema: {
        operationId: "update_proxy_pool",
        description: "Update a managed proxy pool.",
        tags: ["Proxy Pools"],
        body: $ref("ProxyPoolMutation"),
        response: { 200: $ref("ProxyPool") },
      },
    },
    async (
      request: FastifyRequest<{ Params: { id: string }; Body: ProxyPoolMutationRequest["body"] }>,
      reply: FastifyReply,
    ) => {
      try {
        return await managedProxyStore.upsertPool({ ...request.body, id: request.params.id });
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  server.delete(
    "/proxy-pools/:id",
    {
      schema: {
        operationId: "delete_proxy_pool",
        description: "Delete a managed proxy pool when it has no active leases.",
        tags: ["Proxy Pools"],
        response: { 204: { type: "null", description: "No content" } },
      },
    },
    async (request: ProxyPoolParamsRequest, reply: FastifyReply) => {
      try {
        const deleted = await managedProxyStore.deletePool(request.params.id);
        return deleted
          ? reply.code(204).send()
          : reply.code(404).send({ message: "Proxy pool not found" });
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  server.get(
    "/proxy-leases",
    {
      schema: {
        operationId: "list_proxy_leases",
        description: "List managed proxy leases.",
        tags: ["Proxy Leases"],
        response: { 200: $ref("MultipleProxyLeases") },
      },
    },
    async () => ({ proxyLeases: await managedProxyStore.listLeases() }),
  );

  server.post(
    "/proxy-leases",
    {
      schema: {
        operationId: "create_proxy_lease",
        description: "Allocate a managed proxy lease from a pool or explicit proxy ID.",
        tags: ["Proxy Leases"],
        body: $ref("ProxyLeaseRequest"),
        response: { 200: $ref("ProxyLease") },
      },
    },
    async (request: ProxyLeaseMutationRequest, reply: FastifyReply) => {
      try {
        return await managedProxyStore.acquireLease(request.body);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  server.get(
    "/proxy-leases/:id",
    {
      schema: {
        operationId: "get_proxy_lease",
        description: "Get a managed proxy lease.",
        tags: ["Proxy Leases"],
        response: { 200: $ref("ProxyLease") },
      },
    },
    async (request: ProxyLeaseParamsRequest, reply: FastifyReply) => {
      const lease = await managedProxyStore.getLease(request.params.id);
      return lease ?? reply.code(404).send({ message: "Proxy lease not found" });
    },
  );

  server.post(
    "/proxy-leases/:id/release",
    {
      schema: {
        operationId: "release_proxy_lease",
        description: "Release a managed proxy lease.",
        tags: ["Proxy Leases"],
        response: { 200: $ref("ProxyLease") },
      },
    },
    async (request: ProxyLeaseParamsRequest, reply: FastifyReply) => {
      const lease = await managedProxyStore.releaseLease(request.params.id);
      return lease ?? reply.code(404).send({ message: "Proxy lease not found" });
    },
  );
}

export default routes;
