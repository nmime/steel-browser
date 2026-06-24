import fastifyMultipart from "@fastify/multipart";
import { FastifyInstance, FastifyRequest } from "fastify";
import { $ref } from "../../plugins/schemas.js";
import { MB } from "../../utils/size.js";
import { FilesController } from "./files.controller.js";

type FileRouteParams = { sessionId?: string; "*"?: string };

function registerFileScope(
  server: FastifyInstance,
  filesController: FilesController,
  prefix: string,
) {
  const sessionScoped = prefix.includes(":sessionId");
  const scope = sessionScoped ? "session" : "global";

  server.post(
    prefix,
    {
      schema: {
        operationId: sessionScoped ? "upload_file" : "upload_global_file",
        summary: sessionScoped ? "Upload a session file" : "Upload a global file",
        description:
          "Uploads a file via `multipart/form-data` with a `file` field that accepts either binary data or a URL string to download from, and an optional `path` field for the file storage path.",
        tags: ["Files"],
        consumes: ["multipart/form-data"],
        body: $ref("FileUploadRequest"),
        response: { 200: $ref("FileDetails") },
      },
      validatorCompiler: () => (value) => ({ value }),
    },
    async (request: FastifyRequest<{ Params: FileRouteParams }>, reply) =>
      filesController.handleFileUpload(server, request, reply),
  );

  server.post(
    `${prefix}/signed-url`,
    {
      schema: {
        operationId: sessionScoped ? "create_file_signed_url" : "create_global_file_signed_url",
        summary: `Create ${scope} file signed URL`,
        description:
          "Create a signed URL for direct file storage access. The local storage backend returns 501 because signed URLs require a remote provider.",
        tags: ["Files"],
        body: $ref("SignedFileUrlRequest"),
        response: { 200: $ref("SignedFileUrl") },
      },
    },
    async (
      request: FastifyRequest<{
        Params: FileRouteParams;
        Body: {
          path: string;
          operation: "read" | "write";
          expiresInSeconds?: number;
          contentType?: string;
        };
      }>,
      reply,
    ) => filesController.handleCreateSignedUrl(server, request, reply),
  );

  server.head(
    `${prefix}/*`,
    {
      schema: {
        operationId: sessionScoped ? "head_file" : "head_global_file",
        summary: `Head a ${scope} file`,
        description: `Head a file from ${scope} storage`,
        tags: ["Files"],
      },
    },
    async (request: FastifyRequest<{ Params: FileRouteParams & { "*": string } }>, reply) =>
      filesController.handleFileHead(server, request, reply),
  );

  server.get(
    `${prefix}/*`,
    {
      schema: {
        operationId: sessionScoped ? "download_file" : "download_global_file",
        summary: `Download a ${scope} file`,
        description: `Download a file from ${scope} storage`,
        tags: ["Files"],
      },
    },
    async (request: FastifyRequest<{ Params: FileRouteParams & { "*": string } }>, reply) =>
      filesController.handleFileDownload(server, request, reply),
  );

  server.get(
    prefix,
    {
      schema: {
        operationId: sessionScoped ? "list_files" : "list_global_files",
        summary: `List ${scope} files`,
        description: `List files from ${scope} storage in descending order.`,
        tags: ["Files"],
        response: { 200: $ref("MultipleFiles") },
      },
    },
    async (request: FastifyRequest<{ Params: FileRouteParams }>, reply) =>
      filesController.handleFileList(server, request, reply),
  );

  server.delete(
    `${prefix}/*`,
    {
      schema: {
        operationId: sessionScoped ? "delete_file" : "delete_global_file",
        summary: `Delete a ${scope} file`,
        description: `Delete a file from ${scope} storage`,
        tags: ["Files"],
        response: { 204: { type: "null", description: "No content" } },
      },
    },
    async (request: FastifyRequest<{ Params: FileRouteParams & { "*": string } }>, reply) =>
      filesController.handleFileDelete(server, request, reply),
  );

  server.delete(
    prefix,
    {
      schema: {
        operationId: sessionScoped ? "delete_all_files" : "delete_all_global_files",
        summary: `Delete all ${scope} files`,
        description: `Delete all files from ${scope} storage`,
        tags: ["Files"],
        response: { 204: { type: "null", description: "No content" } },
      },
    },
    async (request: FastifyRequest<{ Params: FileRouteParams }>, reply) =>
      filesController.handleFileDeleteAll(server, request, reply),
  );

  server.get(
    `${prefix}.zip`,
    {
      schema: {
        operationId: sessionScoped ? "download_archive" : "download_global_archive",
        summary: `Download ${scope} archive`,
        description: `Download all files from ${scope} storage as a zip archive.`,
        tags: ["Files"],
      },
    },
    async (request: FastifyRequest<{ Params: FileRouteParams }>, reply) =>
      filesController.handleDownloadArchive(server, request, reply),
  );
}

async function routes(server: FastifyInstance) {
  const filesController = new FilesController(server.fileService);

  await server.register(fastifyMultipart, {
    limits: {
      fileSize: server.steelBrowserConfig.fileStorage?.maxSizePerSession ?? 100 * MB,
    },
    attachFieldsToBody: false,
  });

  registerFileScope(server, filesController, "/files");
  registerFileScope(server, filesController, "/sessions/:sessionId/files");
}

export default routes;
