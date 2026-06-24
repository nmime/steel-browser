import { v4 as uuidv4 } from "uuid";
import { env } from "../../env.js";
import { JsonFileMetadataStore, resolveMetadataFilePath } from "../metadata/index.js";
import { redactSensitiveData } from "../../utils/redaction.js";

export type ProfileVersion = {
  id: string;
  version: number;
  label?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type ProfileRecord = {
  id: string;
  name?: string;
  metadata: Record<string, unknown>;
  userDataDir?: string;
  vaultItemIds: string[];
  currentVersion: number;
  versions: ProfileVersion[];
  createdAt: string;
  updatedAt: string;
};

export type ProfileInput = {
  id?: string;
  name?: string;
  metadata?: Record<string, unknown>;
  userDataDir?: string;
  vaultItemIds?: string[];
  versionLabel?: string;
};

type PersistedProfiles = {
  version: 1;
  profiles: Record<string, ProfileRecord>;
};

export class ProfileStore {
  private profiles = new Map<string, ProfileRecord>();
  private loaded = false;
  private readonly store: JsonFileMetadataStore<PersistedProfiles>;

  constructor(private readonly options: { filePath?: string } = {}) {
    this.store = new JsonFileMetadataStore<PersistedProfiles>({
      filePath: resolveMetadataFilePath(
        "profiles",
        options.filePath ?? env.STEEL_PROFILES_STORE_PATH,
        env.STEEL_METADATA_STORE_PATH,
      ),
      defaults: () => ({ version: 1, profiles: {} }),
    });
  }

  async list(): Promise<ProfileRecord[]> {
    await this.load();
    return Array.from(this.profiles.values()).map(toProfileMetadata);
  }

  async get(id: string): Promise<ProfileRecord | undefined> {
    await this.load();
    const profile = this.profiles.get(id);
    return profile ? toProfileMetadata(profile) : undefined;
  }

  async upsert(input: ProfileInput): Promise<ProfileRecord> {
    await this.load();
    const now = new Date().toISOString();
    const existing = input.id ? this.profiles.get(input.id) : undefined;
    const id = input.id || uuidv4();
    const versionNumber = (existing?.currentVersion ?? 0) + 1;
    const version: ProfileVersion = {
      id: uuidv4(),
      version: versionNumber,
      label: input.versionLabel,
      metadata: redactSensitiveData(input.metadata ?? existing?.metadata ?? {}),
      createdAt: now,
    };
    const profile: ProfileRecord = {
      id,
      name: input.name ?? existing?.name,
      metadata: redactSensitiveData(input.metadata ?? existing?.metadata ?? {}),
      userDataDir: input.userDataDir ?? existing?.userDataDir,
      vaultItemIds: input.vaultItemIds ?? existing?.vaultItemIds ?? [],
      currentVersion: versionNumber,
      versions: [...(existing?.versions ?? []), version],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.profiles.set(id, profile);
    await this.persist();
    return toProfileMetadata(profile);
  }

  async addVersion(id: string, input: Pick<ProfileInput, "metadata" | "versionLabel">) {
    const existing = await this.get(id);
    if (!existing) return undefined;
    return this.upsert({
      id,
      name: existing.name,
      metadata: input.metadata ?? existing.metadata,
      userDataDir: existing.userDataDir,
      vaultItemIds: existing.vaultItemIds,
      versionLabel: input.versionLabel,
    });
  }

  async versions(id: string): Promise<ProfileVersion[] | undefined> {
    await this.load();
    const profile = this.profiles.get(id);
    return profile?.versions.map((version) => ({
      ...version,
      metadata: redactSensitiveData(version.metadata),
    }));
  }

  private async load() {
    if (this.loaded) return;
    this.loaded = true;
    const parsed = await this.store.load();
    this.profiles = new Map(Object.entries(parsed.profiles ?? {}));
  }

  private async persist() {
    await this.store.save({
      version: 1,
      profiles: Object.fromEntries(this.profiles),
    });
  }
}

export function toProfileMetadata(profile: ProfileRecord): ProfileRecord {
  return {
    ...profile,
    metadata: redactSensitiveData(profile.metadata),
    versions: profile.versions.map((version) => ({
      ...version,
      metadata: redactSensitiveData(version.metadata),
    })),
  };
}

export const defaultProfileStore = new ProfileStore();
