import { FastifyPluginAsync } from "fastify";

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

const healthSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    role: { type: "string", enum: ["standalone", "scheduler", "worker"] },
    status: { type: "string", enum: ["ready", "busy", "draining", "unhealthy"] },
    capacity: capacitySchema,
    heartbeatIntervalMs: { type: "integer" },
    drainTimeoutMs: { type: "integer" },
    drainStartedAt: { type: "string" },
    updatedAt: { type: "string" },
  },
  required: [
    "id",
    "role",
    "status",
    "capacity",
    "heartbeatIntervalMs",
    "drainTimeoutMs",
    "updatedAt",
  ],
} as const;

const workerRoutes: FastifyPluginAsync = async (server) => {
  server.get(
    "/health",
    {
      schema: {
        description: "Internal worker health endpoint for scheduler heartbeats.",
        tags: ["Internal Worker"],
        response: { 200: healthSchema },
      },
    },
    async () => ({
      ...server.workerRuntime.getHealth(
        server.sessionService.getActiveSessionDetails(),
        server.cdpService.isRunning(),
      ),
      drainStartedAt: server.workerRuntime.getDrainStartedAt(),
    }),
  );

  server.get(
    "/capacity",
    {
      schema: {
        description: "Internal worker session capacity endpoint.",
        tags: ["Internal Worker"],
        response: { 200: capacitySchema },
      },
    },
    async () => server.workerRuntime.getCapacity(server.sessionService.getActiveSessionDetails()),
  );

  server.post(
    "/drain",
    {
      schema: {
        description: "Mark this worker as draining so new sessions are rejected.",
        tags: ["Internal Worker"],
        response: { 200: healthSchema },
      },
    },
    async () => ({
      ...server.workerRuntime.startDraining(),
      drainStartedAt: server.workerRuntime.getDrainStartedAt(),
    }),
  );
};

export default workerRoutes;
