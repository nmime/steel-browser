import { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { WorkerRuntimeService } from "../services/workers/worker-runtime.service.js";

declare module "fastify" {
  interface FastifyInstance {
    workerRuntime: WorkerRuntimeService;
  }
}

const workerRuntimePlugin: FastifyPluginAsync = async (fastify) => {
  fastify.decorate("workerRuntime", new WorkerRuntimeService());
};

export default fp(workerRuntimePlugin, {
  fastify: "5.x",
  name: "worker-runtime",
});
