import { FastifyInstance, FastifyReply } from "fastify";
import { $ref } from "../../plugins/schemas.js";
import { getErrors } from "../../utils/errors.js";
import { VaultStore } from "../../services/vault/vault.store.js";
import { VaultItemMutationRequest, VaultItemParamsRequest } from "./vault.schema.js";

const vaultStore = new VaultStore();

async function routes(server: FastifyInstance) {
  server.get(
    "/vault/items",
    {
      schema: {
        operationId: "list_vault_items",
        description:
          "List encrypted vault item metadata. Secret values and ciphertext are never returned.",
        tags: ["Vault"],
        response: { 200: $ref("VaultItems") },
      },
    },
    async () => ({ items: await vaultStore.list() }),
  );

  server.post(
    "/vault/items",
    {
      schema: {
        operationId: "create_vault_item",
        description: "Encrypt a vault item and return redacted metadata only.",
        tags: ["Vault"],
        body: $ref("VaultItemMutation"),
        response: { 200: $ref("VaultItemMetadata") },
      },
    },
    async (request: VaultItemMutationRequest, reply: FastifyReply) => {
      try {
        return await vaultStore.put(request.body as any);
      } catch (error) {
        server.log.error({ err: error }, "Failed to store vault metadata");
        return reply.code(500).send({ success: false, message: getErrors(error) });
      }
    },
  );

  server.get(
    "/vault/items/:id",
    {
      schema: {
        operationId: "get_vault_item_metadata",
        description:
          "Get redacted metadata for a vault item. Secret values and ciphertext are never returned.",
        tags: ["Vault"],
        response: { 200: $ref("VaultItemMetadata") },
      },
    },
    async (request: VaultItemParamsRequest, reply: FastifyReply) => {
      const item = await vaultStore.get(request.params.id);
      return item ? item : reply.code(404).send({ message: "Vault item not found" });
    },
  );

  server.put(
    "/vault/items/:id",
    {
      schema: {
        operationId: "update_vault_item",
        description: "Replace an encrypted vault item and return redacted metadata only.",
        tags: ["Vault"],
        body: $ref("VaultItemMutation"),
        response: { 200: $ref("VaultItemMetadata") },
      },
    },
    async (request: any, reply: FastifyReply) => {
      try {
        return await vaultStore.put({ ...(request.body as any), id: request.params.id });
      } catch (error) {
        server.log.error({ err: error }, "Failed to update vault metadata");
        return reply.code(500).send({ success: false, message: getErrors(error) });
      }
    },
  );

  server.delete(
    "/vault/items/:id",
    {
      schema: {
        operationId: "delete_vault_item",
        description: "Delete an encrypted vault item.",
        tags: ["Vault"],
        response: { 200: $ref("DeleteVaultItem") },
      },
    },
    async (request: VaultItemParamsRequest) => ({
      success: await vaultStore.delete(request.params.id),
    }),
  );
}

export default routes;
