import { FastifyRequest } from "fastify";
import { z } from "zod";

const ExtensionRegistryEntry = z.object({
  id: z.string(),
  source: z.enum(["local", "registry"]),
  status: z.enum(["available", "invalid", "missing"]),
  path: z.string().optional(),
  name: z.string().optional(),
  version: z.string().optional(),
  manifestVersion: z.number().optional(),
  errors: z.array(z.string()).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

const ExtensionRegistryList = z.object({
  extensions: z.array(ExtensionRegistryEntry),
});

const ExtensionRegistryCapabilities = z.object({
  enabled: z.boolean(),
  localDirectory: z.string(),
  zipValidation: z.literal("central-directory"),
  scanners: z.object({
    clamAv: z.literal(false),
  }),
});

const RegisterExtensionRequest = z.object({
  extensionId: z.string().describe("Local extension directory name to validate/register"),
});

const ExtensionUploadRequest = z.object({
  extensionId: z.string().optional().describe("Optional local extension id/directory name"),
  archiveBase64: z.string().describe("Base64-encoded Chrome extension zip archive"),
});

const ExtensionManifestValidationRequest = z.object({
  manifest: z.unknown(),
});

const ExtensionZipValidationRequest = z.object({
  entries: z
    .array(z.string())
    .optional()
    .describe("Optional zip entry names to validate without upload"),
  archiveBase64: z.string().optional().describe("Optional base64 zip archive to validate"),
});

const ExtensionValidationResult = z.object({
  valid: z.boolean(),
  errors: z.array(z.string()),
  entries: z.array(z.string()).optional(),
  manifest: z.record(z.string(), z.unknown()).optional(),
});

export type RegisterExtensionRequest = FastifyRequest<{
  Body: z.infer<typeof RegisterExtensionRequest>;
}>;
export type ExtensionManifestValidationRequest = FastifyRequest<{
  Body: z.infer<typeof ExtensionManifestValidationRequest>;
}>;
export type ExtensionZipValidationRequest = FastifyRequest<{
  Body: z.infer<typeof ExtensionZipValidationRequest>;
}>;
export type ExtensionUploadRequest = FastifyRequest<{
  Body: z.infer<typeof ExtensionUploadRequest>;
}>;
export type ExtensionIdRequest = FastifyRequest<{ Params: { extensionId: string } }>;

export const extensionSchemas = {
  ExtensionRegistryEntry,
  ExtensionRegistryList,
  ExtensionRegistryCapabilities,
  RegisterExtensionRequest,
  ExtensionUploadRequest,
  ExtensionManifestValidationRequest,
  ExtensionZipValidationRequest,
  ExtensionValidationResult,
};

export default extensionSchemas;
