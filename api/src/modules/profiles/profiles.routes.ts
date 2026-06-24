import { FastifyInstance, FastifyReply } from "fastify";
import { $ref } from "../../plugins/schemas.js";
import { getErrors } from "../../utils/errors.js";
import { ProfileSnapshotService } from "../../services/profiles/profile-snapshot.service.js";
import { defaultProfileStore } from "../../services/profiles/profile.store.js";
import {
  ProfileMutationRequest,
  ProfileParamsRequest,
  ProfileRestoreRequest,
  ProfileSnapshotRequest,
  ProfileVersionMutationRequest,
} from "./profiles.schema.js";

function sendProfileError(reply: FastifyReply, error: unknown) {
  const statusCode =
    typeof (error as any)?.statusCode === "number" ? (error as any).statusCode : 500;
  return reply.code(statusCode).send({ success: false, message: getErrors(error) });
}

async function routes(server: FastifyInstance) {
  const profileStore = defaultProfileStore;
  const snapshots = new ProfileSnapshotService(profileStore, server.fileService);

  server.get(
    "/profiles",
    {
      schema: {
        operationId: "list_profiles",
        description: "List profile metadata and version skeletons.",
        tags: ["Profiles"],
        response: { 200: $ref("Profiles") },
      },
    },
    async () => ({ profiles: await profileStore.list() }),
  );

  server.post(
    "/profiles",
    {
      schema: {
        operationId: "create_profile",
        description: "Create or update profile metadata and record a profile version skeleton.",
        tags: ["Profiles"],
        body: $ref("ProfileMutation"),
        response: { 200: $ref("ProfileMetadata") },
      },
    },
    async (request: ProfileMutationRequest) => profileStore.upsert(request.body),
  );

  server.get(
    "/profiles/:id",
    {
      schema: {
        operationId: "get_profile",
        description: "Get profile metadata and version skeletons.",
        tags: ["Profiles"],
        response: { 200: $ref("ProfileMetadata") },
      },
    },
    async (request: ProfileParamsRequest, reply: FastifyReply) => {
      const profile = await profileStore.get(request.params.id);
      return profile ? profile : reply.code(404).send({ message: "Profile not found" });
    },
  );

  server.get(
    "/profiles/:id/versions",
    {
      schema: {
        operationId: "list_profile_versions",
        description: "List version skeletons for a profile.",
        tags: ["Profiles"],
        response: { 200: $ref("ProfileVersions") },
      },
    },
    async (request: ProfileParamsRequest, reply: FastifyReply) => {
      const versions = await profileStore.versions(request.params.id);
      return versions ? { versions } : reply.code(404).send({ message: "Profile not found" });
    },
  );

  server.post(
    "/profiles/:id/versions",
    {
      schema: {
        operationId: "create_profile_version",
        description: "Record a new metadata-only profile version skeleton.",
        tags: ["Profiles"],
        body: $ref("ProfileVersionMutation"),
        response: { 200: $ref("ProfileMetadata") },
      },
    },
    async (request: ProfileVersionMutationRequest, reply: FastifyReply) => {
      const profile = await profileStore.addVersion(request.params.id, request.body);
      return profile ? profile : reply.code(404).send({ message: "Profile not found" });
    },
  );

  server.post(
    "/profiles/:id/snapshots",
    {
      schema: {
        operationId: "snapshot_profile",
        description:
          "Archive a browser userDataDir into file storage and append a materialized profile version.",
        tags: ["Profiles"],
        body: $ref("ProfileSnapshotRequest"),
        response: { 200: $ref("ProfileMetadata") },
      },
    },
    async (request: ProfileSnapshotRequest, reply: FastifyReply) => {
      try {
        const sourceUserDataDir =
          request.body.userDataDir ??
          server.sessionService.getActiveUserDataDir(request.body.sessionId);
        if (!sourceUserDataDir) {
          return reply
            .code(400)
            .send({ success: false, message: "userDataDir or active sessionId is required" });
        }
        return await snapshots.snapshot({
          profileId: request.params.id,
          sourceUserDataDir,
          versionLabel: request.body.versionLabel,
          metadata: request.body.metadata,
        });
      } catch (error) {
        return sendProfileError(reply, error);
      }
    },
  );

  server.post(
    "/profiles/:id/restore",
    {
      schema: {
        operationId: "restore_profile",
        description: "Materialize a stored profile snapshot into a browser userDataDir.",
        tags: ["Profiles"],
        body: $ref("ProfileRestoreRequest"),
        response: { 200: $ref("ProfileRestoreResponse") },
      },
    },
    async (request: ProfileRestoreRequest, reply: FastifyReply) => {
      try {
        const restored = await snapshots.restore({
          profileId: request.params.id,
          version: request.body.version,
          targetUserDataDir: request.body.userDataDir,
        });
        return {
          profile: restored.profile,
          storagePath: restored.storagePath,
          restoredFileCount: restored.restoredFiles.length,
          userDataDir: request.body.userDataDir,
        };
      } catch (error) {
        return sendProfileError(reply, error);
      }
    },
  );
}

export default routes;
