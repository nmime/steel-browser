import { v4 as uuidv4 } from "uuid";
import { env } from "../../env.js";
import { JsonFileMetadataStore, resolveMetadataFilePath } from "../metadata/index.js";
import { REDACTED, redactSensitiveData } from "../../utils/redaction.js";
import { VaultEnvelope, encryptEnvelope, loadMasterKey } from "./encryption.js";

export type VaultItemType = "credential" | "totp" | "cookie" | "note" | "generic";

export type VaultItemRecord = {
  id: string;
  type: VaultItemType;
  name?: string;
  metadata: Record<string, unknown>;
  envelope: VaultEnvelope;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type VaultItemMetadata = Omit<VaultItemRecord, "envelope"> & {
  encrypted: true;
  secret: typeof REDACTED;
};

export type VaultItemInput = {
  id?: string;
  type?: VaultItemType;
  name?: string;
  metadata?: Record<string, unknown>;
  secret: unknown;
};

type PersistedVault = {
  version: 1;
  items: Record<string, VaultItemRecord>;
};

export class VaultStore {
  private items = new Map<string, VaultItemRecord>();
  private loaded = false;
  private readonly store: JsonFileMetadataStore<PersistedVault>;

  constructor(
    private readonly options: {
      filePath?: string;
      masterKey?: string;
      masterKeyFile?: string;
    } = {},
  ) {
    this.store = new JsonFileMetadataStore<PersistedVault>({
      filePath: resolveMetadataFilePath(
        "vault",
        options.filePath ?? env.STEEL_VAULT_STORE_PATH,
        env.STEEL_METADATA_STORE_PATH,
      ),
      defaults: () => ({ version: 1, items: {} }),
    });
  }

  async list(): Promise<VaultItemMetadata[]> {
    await this.load();
    return Array.from(this.items.values()).map(toMetadata);
  }

  async get(id: string): Promise<VaultItemMetadata | undefined> {
    await this.load();
    const item = this.items.get(id);
    return item ? toMetadata(item) : undefined;
  }

  async put(input: VaultItemInput): Promise<VaultItemMetadata> {
    await this.load();
    const now = new Date().toISOString();
    const existing = input.id ? this.items.get(input.id) : undefined;
    const id = input.id || uuidv4();
    const envelope = encryptEnvelope(JSON.stringify(input.secret), await this.masterKey());
    const record: VaultItemRecord = {
      id,
      type: input.type ?? existing?.type ?? "generic",
      name: input.name ?? existing?.name,
      metadata: redactSensitiveData(input.metadata ?? existing?.metadata ?? {}),
      envelope,
      version: (existing?.version ?? 0) + 1,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.items.set(id, record);
    await this.persist();
    return toMetadata(record);
  }

  async delete(id: string): Promise<boolean> {
    await this.load();
    const deleted = this.items.delete(id);
    if (deleted) {
      await this.persist();
    }
    return deleted;
  }

  private async masterKey() {
    return loadMasterKey({
      key: this.options.masterKey ?? env.STEEL_VAULT_MASTER_KEY,
      keyFile: this.options.masterKeyFile ?? env.STEEL_VAULT_MASTER_KEY_FILE,
    });
  }

  private async load() {
    if (this.loaded) return;
    this.loaded = true;

    const parsed = await this.store.load();
    this.items = new Map(Object.entries(parsed.items ?? {}));
  }

  private async persist() {
    await this.store.save({
      version: 1,
      items: Object.fromEntries(this.items),
    });
  }
}

export function toMetadata(item: VaultItemRecord): VaultItemMetadata {
  const { envelope: _envelope, ...safe } = item;
  return {
    ...safe,
    metadata: redactSensitiveData(safe.metadata),
    encrypted: true,
    secret: REDACTED,
  };
}
