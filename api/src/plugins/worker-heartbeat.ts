import { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { env } from "../env.js";
import { getErrors } from "../utils/errors.js";
import { WorkerRegistration } from "../services/workers/types.js";

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, "");

function workerEndpoint(): string {
  if (env.WORKER_PUBLIC_URL) return trimTrailingSlash(env.WORKER_PUBLIC_URL);
  const host = env.HOST === "0.0.0.0" ? "localhost" : env.HOST;
  return `http://${host}:${env.PORT}`;
}

const workerHeartbeatPlugin: FastifyPluginAsync = async (fastify) => {
  if (env.STEEL_ROLE !== "worker" || !env.SCHEDULER_URL) return;

  const schedulerUrl = trimTrailingSlash(env.SCHEDULER_URL);
  const heartbeatUrl = `${schedulerUrl}/v1/scheduler/workers/heartbeat`;

  const sendHeartbeat = async () => {
    const health = fastify.workerRuntime.getHealth(
      fastify.sessionService.getActiveSessionDetails(),
      fastify.cdpService.isRunning(),
    );
    const registration: WorkerRegistration = {
      id: health.id,
      endpoint: workerEndpoint(),
      state: health.status,
      capacity: health.capacity,
      lastHeartbeatAt: health.updatedAt,
      metadata: {
        heartbeatIntervalMs: health.heartbeatIntervalMs,
        drainTimeoutMs: health.drainTimeoutMs,
      },
    };

    const headers: Record<string, string> = { "content-type": "application/json" };
    if (env.STEEL_API_KEY) headers["x-api-key"] = env.STEEL_API_KEY;

    try {
      const response = await fetch(heartbeatUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(registration),
      });
      if (!response.ok) {
        fastify.log.warn(
          { statusCode: response.status },
          "worker heartbeat was rejected by scheduler",
        );
      }
    } catch (error) {
      fastify.log.warn({ err: getErrors(error) }, "worker heartbeat failed");
    }
  };

  let timer: NodeJS.Timeout | undefined;
  fastify.addHook("onReady", async () => {
    await sendHeartbeat();
    timer = setInterval(sendHeartbeat, fastify.workerRuntime.heartbeatIntervalMs);
    timer.unref();
  });

  fastify.addHook("onClose", async () => {
    if (timer) clearInterval(timer);
  });
};

export default fp(workerHeartbeatPlugin, {
  name: "worker-heartbeat",
  dependencies: ["worker-runtime"],
});
