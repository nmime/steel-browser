import { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { InMemoryWorkerRegistry } from "../services/workers/in-memory-worker-registry.js";
import { SchedulerService } from "../services/workers/scheduler.service.js";

declare module "fastify" {
  interface FastifyInstance {
    schedulerService: SchedulerService;
  }
}

const schedulerRuntimePlugin: FastifyPluginAsync = async (fastify) => {
  fastify.decorate("schedulerService", new SchedulerService(new InMemoryWorkerRegistry()));
};

export default fp(schedulerRuntimePlugin, {
  name: "scheduler-runtime",
});
