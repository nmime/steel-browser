import { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { env } from "../env.js";

const schedulerRoutingPlugin: FastifyPluginAsync = async (fastify) => {
  if (env.STEEL_ROLE !== "scheduler") return;

  fastify.addHook("preHandler", async (request, reply) => {
    if (reply.sent) return;
    const result = await fastify.schedulerService.routeHttpRequest(request, reply);
    if (result.proxied) return reply;
  });
};

export default fp(schedulerRoutingPlugin, {
  name: "scheduler-routing",
  dependencies: ["scheduler-runtime"],
});
