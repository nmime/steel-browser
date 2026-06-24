import { FastifyRequest } from "fastify";
import { z } from "zod";

const TraceArtifactFormat = z.enum(["jsonl", "har", "zip"]);

const TraceArtifactFile = z.object({
  path: z.string(),
  role: z.enum(["metadata", "jsonl", "har", "archive"]),
  contentType: z.string(),
  size: z.number(),
  storageProvider: z.string(),
  lastModified: z.string().datetime(),
});

const TraceArtifactQuery = z.object({
  startTime: z.string().datetime().optional(),
  endTime: z.string().datetime().optional(),
  eventTypes: z.array(z.string()).optional(),
  pageId: z.string().optional(),
  targetType: z.string().optional(),
  limit: z.number().int().min(1).optional(),
  offset: z.number().int().nonnegative().optional(),
});

const TraceArtifact = z.object({
  id: z.string(),
  kind: z.enum(["trace", "replay"]),
  format: TraceArtifactFormat,
  status: z.enum(["pending", "ready", "failed"]),
  sessionId: z.string().optional(),
  label: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  path: z.string(),
  contentType: z.string(),
  size: z.number(),
  storageProvider: z.string(),
  files: z.array(TraceArtifactFile),
  query: TraceArtifactQuery.optional(),
  eventCount: z.number(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  error: z.string().optional(),
});

const TraceArtifactList = z.object({
  artifacts: z.array(TraceArtifact),
});

const TraceArtifactCapabilities = z.object({
  enabled: z.boolean(),
  storageProvider: z.literal("local"),
  storagePrefix: z.string(),
  maxBytes: z.number(),
  maxEvents: z.number(),
  formats: z.object({ jsonl: z.literal(true), har: z.literal(true), zip: z.literal(true) }),
  transcoders: z.object({ ffmpeg: z.literal(false) }),
  scanners: z.object({ clamAv: z.literal(false) }),
});

const CreateTraceArtifactRequest = z.object({
  kind: z.enum(["trace", "replay"]),
  format: TraceArtifactFormat.optional(),
  sessionId: z.string().optional(),
  label: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  query: TraceArtifactQuery.optional(),
});

export type CreateTraceArtifactRequest = FastifyRequest<{
  Body: z.infer<typeof CreateTraceArtifactRequest>;
}>;
export type TraceArtifactIdRequest = FastifyRequest<{ Params: { artifactId: string } }>;

export const telemetrySchemas = {
  TraceArtifact,
  TraceArtifactFile,
  TraceArtifactList,
  TraceArtifactCapabilities,
  CreateTraceArtifactRequest,
};

export default telemetrySchemas;
