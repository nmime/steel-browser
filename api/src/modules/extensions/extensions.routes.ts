import { FastifyInstance } from "fastify";
import { $ref } from "../../plugins/schemas.js";
import { ExtensionRegistryService } from "../../services/extensions/extension-registry.service.js";
import {
  ExtensionIdRequest,
  ExtensionManifestValidationRequest,
  ExtensionUploadRequest,
  ExtensionZipValidationRequest,
  RegisterExtensionRequest,
} from "./extensions.schema.js";
import {
  validateArchiveEntries,
  validateExtensionManifest,
  validateExtensionZipBuffer,
} from "../../utils/extensions.js";

async function routes(server: FastifyInstance) {
  const registry = new ExtensionRegistryService();

  server.get(
    "/extensions/capabilities",
    {
      schema: {
        operationId: "get_extension_capabilities",
        tags: ["Extensions"],
        summary: "Get extension registry capabilities",
        response: { 200: $ref("ExtensionRegistryCapabilities") },
      },
    },
    async () => registry.capabilities(),
  );

  server.get(
    "/extensions",
    {
      schema: {
        operationId: "list_extensions",
        tags: ["Extensions"],
        summary: "List local browser extensions",
        response: { 200: $ref("ExtensionRegistryList") },
      },
    },
    async () => ({ extensions: await registry.list() }),
  );

  server.get(
    "/extensions/:extensionId",
    {
      schema: {
        operationId: "get_extension",
        tags: ["Extensions"],
        summary: "Get local extension details",
        response: { 200: $ref("ExtensionRegistryEntry") },
      },
    },
    async (request: ExtensionIdRequest, reply) => {
      const extension = await registry.get(request.params.extensionId);
      if (!extension) return reply.notFound("Extension not found");
      return extension;
    },
  );

  server.post(
    "/extensions/upload",
    {
      schema: {
        operationId: "upload_extension",
        tags: ["Extensions"],
        summary: "Upload and materialize a Chrome extension zip",
        body: $ref("ExtensionUploadRequest"),
        response: { 200: $ref("ExtensionRegistryEntry") },
      },
    },
    async (request: ExtensionUploadRequest) =>
      registry.uploadArchive({
        extensionId: request.body.extensionId,
        archiveBuffer: Buffer.from(request.body.archiveBase64, "base64"),
      }),
  );

  server.post(
    "/extensions/registry",
    {
      schema: {
        operationId: "register_extension",
        tags: ["Extensions"],
        summary: "Validate/register an existing local extension",
        body: $ref("RegisterExtensionRequest"),
        response: { 200: $ref("ExtensionRegistryEntry") },
      },
    },
    async (request: RegisterExtensionRequest) => registry.registerLocal(request.body.extensionId),
  );

  server.post(
    "/extensions/validate-manifest",
    {
      schema: {
        operationId: "validate_extension_manifest",
        tags: ["Extensions"],
        summary: "Validate a Chrome extension manifest payload",
        body: $ref("ExtensionManifestValidationRequest"),
        response: { 200: $ref("ExtensionValidationResult") },
      },
    },
    async (request: ExtensionManifestValidationRequest) =>
      validateExtensionManifest(request.body.manifest),
  );

  server.post(
    "/extensions/validate-zip",
    {
      schema: {
        operationId: "validate_extension_zip",
        tags: ["Extensions"],
        summary: "Validate extension zip entry paths for traversal issues",
        body: $ref("ExtensionZipValidationRequest"),
        response: { 200: $ref("ExtensionValidationResult") },
      },
    },
    async (request: ExtensionZipValidationRequest) => {
      if (request.body.archiveBase64) {
        return validateExtensionZipBuffer(Buffer.from(request.body.archiveBase64, "base64"));
      }
      return validateArchiveEntries(request.body.entries ?? []);
    },
  );
}

export default routes;
