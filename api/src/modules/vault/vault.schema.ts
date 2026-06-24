import { FastifyRequest } from "fastify";
import { z } from "zod";

const VaultItemType = z.enum(["credential", "totp", "cookie", "note", "generic"]);

const VaultItemMutation = z.object({
  id: z.string().uuid().optional(),
  type: VaultItemType.default("generic"),
  name: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.any()).optional(),
  secret: z.any().describe("Secret payload to encrypt. Never returned by metadata APIs."),
});

const VaultItemMetadata = z.object({
  id: z.string().uuid(),
  type: VaultItemType,
  name: z.string().optional(),
  metadata: z.record(z.string(), z.any()),
  version: z.number().int().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  encrypted: z.literal(true),
  secret: z.literal("[REDACTED]"),
});

const VaultItems = z.object({
  items: z.array(VaultItemMetadata),
});

const DeleteVaultItem = z.object({
  success: z.boolean(),
});

export type VaultItemMutationBody = z.infer<typeof VaultItemMutation>;
export type VaultItemMutationRequest = FastifyRequest<{ Body: VaultItemMutationBody }>;
export type VaultItemParamsRequest = FastifyRequest<{ Params: { id: string } }>;

export const vaultSchemas = {
  VaultItemMutation,
  VaultItemMetadata,
  VaultItems,
  DeleteVaultItem,
};

export default vaultSchemas;
