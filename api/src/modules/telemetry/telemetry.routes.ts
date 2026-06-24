import path from "path";
import { FastifyInstance } from "fastify";
import { $ref } from "../../plugins/schemas.js";
import { TraceArtifactService } from "../../services/telemetry/trace-artifact.service.js";
import { CreateTraceArtifactRequest, TraceArtifactIdRequest } from "./telemetry.schema.js";

async function routes(server: FastifyInstance) {
  const artifacts = new TraceArtifactService({
    fileService: server.fileService,
    logStorage: server.cdpService.getInstrumentationLogger()?.getStorage?.() ?? null,
    logger: server.log,
  });

  server.get(
    "/telemetry/artifacts/capabilities",
    {
      schema: {
        operationId: "get_trace_artifact_capabilities",
        tags: ["Telemetry"],
        summary: "Get trace/replay artifact capabilities",
        response: { 200: $ref("TraceArtifactCapabilities") },
      },
    },
    async () => artifacts.capabilities(),
  );

  server.get(
    "/telemetry/artifacts",
    {
      schema: {
        operationId: "list_trace_artifacts",
        tags: ["Telemetry"],
        summary: "List trace/replay artifact metadata",
        response: { 200: $ref("TraceArtifactList") },
      },
    },
    async () => ({ artifacts: await artifacts.list() }),
  );

  server.get(
    "/telemetry/artifacts/:artifactId",
    {
      schema: {
        operationId: "get_trace_artifact",
        tags: ["Telemetry"],
        summary: "Get trace/replay artifact metadata",
        response: { 200: $ref("TraceArtifact") },
      },
    },
    async (request: TraceArtifactIdRequest, reply) => {
      const artifact = await artifacts.get(request.params.artifactId);
      if (!artifact) return reply.notFound("Artifact not found");
      return artifact;
    },
  );

  server.get(
    "/telemetry/artifacts/:artifactId/content",
    {
      schema: {
        operationId: "download_trace_artifact",
        tags: ["Telemetry"],
        summary: "Download the primary trace/replay artifact payload",
      },
    },
    async (request: TraceArtifactIdRequest, reply) => {
      try {
        const { artifact, stream } = await artifacts.download(request.params.artifactId);
        return reply
          .type(artifact.contentType)
          .header(
            "Content-Disposition",
            `attachment; filename="${path.basename(artifact.path).replace(/"/g, "")}"`,
          )
          .send(stream);
      } catch {
        return reply.notFound("Artifact not found");
      }
    },
  );

  server.post(
    "/telemetry/artifacts",
    {
      schema: {
        operationId: "create_trace_artifact",
        tags: ["Telemetry"],
        summary: "Export trace/replay artifact from browser logger events",
        description:
          "Exports JSONL, HAR-ish JSON, or ZIP trace/replay metadata artifacts to the configured file storage provider. Video capture and ffmpeg transcoding are not included.",
        body: $ref("CreateTraceArtifactRequest"),
        response: { 200: $ref("TraceArtifact") },
      },
    },
    async (request: CreateTraceArtifactRequest, reply) => {
      try {
        return await artifacts.create(request.body);
      } catch (error) {
        return reply.code(503).send({
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );
}

export default routes;
