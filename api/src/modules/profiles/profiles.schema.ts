import { FastifyRequest } from "fastify";
import { z } from "zod";

const ProfileMutation = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.any()).optional(),
  userDataDir: z.string().optional(),
  vaultItemIds: z.array(z.string().uuid()).optional(),
  versionLabel: z.string().optional(),
});

const ProfileVersionMutation = z.object({
  metadata: z.record(z.string(), z.any()).optional(),
  versionLabel: z.string().optional(),
});

const ProfileSnapshotRequest = z.object({
  sessionId: z.string().uuid().optional().describe("Active session id to snapshot"),
  userDataDir: z.string().optional().describe("Explicit user data directory to snapshot"),
  metadata: z.record(z.string(), z.any()).optional(),
  versionLabel: z.string().optional(),
});

const ProfileRestoreRequest = z.object({
  version: z.number().int().min(1).optional(),
  userDataDir: z.string().describe("Target user data directory to materialize the snapshot into"),
});

const ProfileVersion = z.object({
  id: z.string().uuid(),
  version: z.number().int().min(1),
  label: z.string().optional(),
  metadata: z.record(z.string(), z.any()),
  createdAt: z.string().datetime(),
});

const ProfileMetadata = z.object({
  id: z.string().uuid(),
  name: z.string().optional(),
  metadata: z.record(z.string(), z.any()),
  userDataDir: z.string().optional(),
  vaultItemIds: z.array(z.string().uuid()),
  currentVersion: z.number().int().min(1),
  versions: z.array(ProfileVersion),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

const ProfileRestoreResponse = z.object({
  profile: ProfileMetadata,
  storagePath: z.string(),
  restoredFileCount: z.number().int().nonnegative(),
  userDataDir: z.string(),
});

const Profiles = z.object({ profiles: z.array(ProfileMetadata) });
const ProfileVersions = z.object({ versions: z.array(ProfileVersion) });

export type ProfileMutationBody = z.infer<typeof ProfileMutation>;
export type ProfileVersionMutationBody = z.infer<typeof ProfileVersionMutation>;
export type ProfileMutationRequest = FastifyRequest<{ Body: ProfileMutationBody }>;
export type ProfileVersionMutationRequest = FastifyRequest<{
  Body: ProfileVersionMutationBody;
  Params: { id: string };
}>;
export type ProfileSnapshotRequest = FastifyRequest<{
  Body: z.infer<typeof ProfileSnapshotRequest>;
  Params: { id: string };
}>;
export type ProfileRestoreRequest = FastifyRequest<{
  Body: z.infer<typeof ProfileRestoreRequest>;
  Params: { id: string };
}>;
export type ProfileParamsRequest = FastifyRequest<{ Params: { id: string } }>;

export const profileSchemas = {
  ProfileMutation,
  ProfileVersionMutation,
  ProfileSnapshotRequest,
  ProfileRestoreRequest,
  ProfileMetadata,
  ProfileVersion,
  Profiles,
  ProfileVersions,
  ProfileRestoreResponse,
};

export default profileSchemas;
