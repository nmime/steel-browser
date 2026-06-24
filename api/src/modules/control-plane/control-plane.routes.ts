import { FastifyPluginAsync } from "fastify";
import { NoopControlPlaneService } from "./control-plane.service.js";

const capabilitySchema = {
  type: "object",
  properties: {
    enabled: { type: "boolean" },
    implemented: { type: "boolean" },
  },
  required: ["enabled", "implemented"],
} as const;

const controlPlaneRoutes: FastifyPluginAsync = async (server) => {
  const controlPlaneService = new NoopControlPlaneService();

  server.get(
    "/status",
    {
      schema: {
        description:
          "Self-hosted control-plane capability status. This endpoint is a no-op skeleton and is only registered when STEEL_CONTROL_PLANE_ENABLED=true.",
        tags: ["Control Plane"],
        response: {
          200: {
            type: "object",
            properties: {
              mode: { type: "string", enum: ["noop"] },
              capabilities: {
                type: "object",
                properties: {
                  auth: capabilitySchema,
                  worker: capabilitySchema,
                  remoteStorage: capabilitySchema,
                  challengeDetection: capabilitySchema,
                  proxyManagement: capabilitySchema,
                },
                required: [
                  "auth",
                  "worker",
                  "remoteStorage",
                  "challengeDetection",
                  "proxyManagement",
                ],
              },
            },
            required: ["mode", "capabilities"],
          },
        },
      },
    },
    async () => controlPlaneService.getStatus(),
  );
};

export default controlPlaneRoutes;
