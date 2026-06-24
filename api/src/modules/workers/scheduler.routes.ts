import { FastifyPluginAsync } from "fastify";
import { WorkerAllocationRequest, WorkerRegistration } from "../../services/workers/types.js";

const capacitySchema = {
  type: "object",
  properties: {
    maxSessions: { type: "integer" },
    configuredMaxSessions: { type: "integer" },
    activeSessions: { type: "integer" },
    availableSessions: { type: "integer" },
    acceptingSessions: { type: "boolean" },
    draining: { type: "boolean" },
    idleBrowser: { type: "boolean" },
  },
  required: [
    "maxSessions",
    "configuredMaxSessions",
    "activeSessions",
    "availableSessions",
    "acceptingSessions",
    "draining",
    "idleBrowser",
  ],
} as const;

const workerRegistrationSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    endpoint: { type: "string" },
    state: { type: "string", enum: ["ready", "busy", "draining", "unhealthy"] },
    capacity: capacitySchema,
    lastHeartbeatAt: { type: "string" },
    metadata: { type: "object", additionalProperties: true },
  },
  required: ["id", "state", "capacity", "lastHeartbeatAt"],
} as const;

const schedulerRoutes: FastifyPluginAsync = async (server) => {
  server.get(
    "/status",
    {
      schema: {
        description: "Scheduler status, registered workers, and session routing table.",
        tags: ["Scheduler"],
        response: {
          200: {
            type: "object",
            properties: {
              mode: { type: "string", enum: ["routing"] },
              role: { type: "string", enum: ["scheduler"] },
              implemented: { type: "boolean" },
              registeredWorkers: { type: "integer" },
              workers: { type: "array", items: workerRegistrationSchema },
              sessions: { type: "array", items: { type: "object", additionalProperties: true } },
            },
            required: ["mode", "role", "implemented", "registeredWorkers", "workers", "sessions"],
          },
        },
      },
    },
    async () => {
      const workers = await server.schedulerService.listWorkers();
      return {
        mode: "routing" as const,
        role: "scheduler" as const,
        implemented: true,
        registeredWorkers: workers.length,
        workers,
        sessions: server.schedulerService.listSessionMappings(),
      };
    },
  );

  server.post(
    "/workers/heartbeat",
    {
      schema: {
        description: "Register or update a worker heartbeat in the scheduler registry.",
        tags: ["Scheduler"],
        body: workerRegistrationSchema,
        response: { 200: workerRegistrationSchema },
      },
    },
    async (request) => server.schedulerService.registerWorker(request.body as WorkerRegistration),
  );

  server.post(
    "/workers/:workerId/drain",
    {
      schema: {
        description:
          "Mark a registered worker as draining so the scheduler stops assigning new sessions.",
        tags: ["Scheduler"],
        params: {
          type: "object",
          properties: { workerId: { type: "string" } },
          required: ["workerId"],
        },
        response: {
          200: workerRegistrationSchema,
          404: { type: "object", additionalProperties: true },
        },
      },
    },
    async (request, reply) => {
      const { workerId } = request.params as { workerId: string };
      const worker = await server.schedulerService.markWorkerDraining(workerId);
      if (!worker) return reply.code(404).send({ success: false, message: "Worker not found" });
      return worker;
    },
  );

  server.post(
    "/allocate",
    {
      schema: {
        description:
          "Allocate an idle registered worker to a session and record the scheduler session route.",
        tags: ["Scheduler"],
        body: {
          type: "object",
          properties: {
            sessionId: { type: "string" },
            requiredSessions: { type: "integer" },
            metadata: { type: "object", additionalProperties: true },
          },
          additionalProperties: true,
        },
        response: {
          200: {
            type: "object",
            properties: {
              status: { type: "string", enum: ["allocated", "unavailable", "noop"] },
              sessionId: { type: "string" },
              worker: workerRegistrationSchema,
              mapping: { type: "object", additionalProperties: true },
              reason: { type: "string" },
            },
            required: ["status"],
          },
        },
      },
    },
    async (request) =>
      server.schedulerService.allocate((request.body ?? undefined) as WorkerAllocationRequest),
  );
};

export default schedulerRoutes;
