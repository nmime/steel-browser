import { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { InMemoryWorkerRegistry } from "../services/workers/in-memory-worker-registry.js";
import { SchedulerService } from "../services/workers/scheduler.service.js";
import { env } from "../env.js";

declare module "fastify" {
  interface FastifyInstance {
    schedulerService: SchedulerService;
  }
}

const schedulerRuntimePlugin: FastifyPluginAsync = async (fastify) => {
  fastify.decorate("schedulerService", new SchedulerService(new InMemoryWorkerRegistry()));
  if (env.STEEL_ROLE === "scheduler") {
    const sweepInterval = Math.max(1000, env.STEEL_SESSION_RECOVERY_SWEEP_INTERVAL_MS);
    const timer = setInterval(() => {
      fastify.schedulerService.recoverStaleWorkers().catch((err) => {
        fastify.log.warn({ err }, "Failed to sweep stale workers for session recovery");
      });
    }, sweepInterval);
    fastify.addHook("onClose", async () => clearInterval(timer));
  }
};

export default fp(schedulerRuntimePlugin, {
  name: "scheduler-runtime",
});
