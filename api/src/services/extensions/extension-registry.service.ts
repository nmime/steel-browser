import fs from "fs/promises";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { env } from "../../env.js";
import {
  getExtensionsRoot,
  isSafeExtensionName,
  validateExtensionDirectory,
  validateExtensionZipBuffer,
} from "../../utils/extensions.js";
import { extractZipBuffer } from "../../utils/zip.js";
import { JsonFileMetadataStore, resolveMetadataFilePath } from "../metadata/index.js";

export type ExtensionRegistrySource = "local" | "registry";
export type ExtensionRegistryStatus = "available" | "invalid" | "missing";

export interface ExtensionRegistryEntry {
  id: string;
  source: ExtensionRegistrySource;
  status: ExtensionRegistryStatus;
  path?: string;
  name?: string;
  version?: string;
  manifestVersion?: number;
  errors?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ExtensionRegistryCapabilities {
  enabled: boolean;
  localDirectory: string;
  zipValidation: "central-directory";
  scanners: {
    clamAv: false;
  };
}

type PersistedExtensionRegistry = {
  version: 1;
  entries: Record<string, ExtensionRegistryEntry>;
};

export class ExtensionRegistryService {
  private readonly store: JsonFileMetadataStore<PersistedExtensionRegistry>;

  constructor(
    private readonly root: string = env.STEEL_EXTENSIONS_DIR || getExtensionsRoot(),
    storePath = resolveMetadataFilePath(
      "extensions",
      env.STEEL_EXTENSIONS_STORE_PATH,
      env.STEEL_METADATA_STORE_PATH,
    ),
  ) {
    this.store = new JsonFileMetadataStore<PersistedExtensionRegistry>({
      filePath: storePath,
      defaults: () => ({ version: 1, entries: {} }),
    });
  }

  public capabilities(): ExtensionRegistryCapabilities {
    return {
      enabled: env.STEEL_EXTENSIONS_REGISTRY_ENABLED,
      localDirectory: this.root,
      zipValidation: "central-directory",
      scanners: { clamAv: false },
    };
  }

  public async list(): Promise<ExtensionRegistryEntry[]> {
    const persisted = (await this.store.load()).entries;
    let names: string[] = [];
    try {
      names = await fs.readdir(this.root);
    } catch {
      names = [];
    }

    const localEntries = await Promise.all(
      names.filter(isSafeExtensionName).map((name) => this.describeLocalExtension(name)),
    );
    const merged = new Map<string, ExtensionRegistryEntry>(Object.entries(persisted));
    for (const entry of localEntries) merged.set(entry.id, { ...merged.get(entry.id), ...entry });
    return Array.from(merged.values()).sort((a, b) => a.id.localeCompare(b.id));
  }

  public async get(extensionId: string): Promise<ExtensionRegistryEntry | undefined> {
    if (!isSafeExtensionName(extensionId)) return undefined;
    const extensionPath = path.join(this.root, extensionId);
    try {
      await fs.access(extensionPath);
      const local = await this.describeLocalExtension(extensionId);
      await this.persistEntry({ ...local, source: "registry" });
      return local;
    } catch {
      return (await this.store.load()).entries[extensionId];
    }
  }

  public async uploadArchive(input: {
    archiveBuffer: Buffer;
    extensionId?: string;
  }): Promise<ExtensionRegistryEntry> {
    const validation = validateExtensionZipBuffer(input.archiveBuffer);
    if (!validation.valid) {
      const entry = this.entry(
        input.extensionId ?? "upload",
        "invalid",
        undefined,
        validation.errors,
      );
      await this.persistEntry({ ...entry, source: "registry" });
      return entry;
    }

    const extensionId = input.extensionId ?? `uploaded-${uuidv4()}`;
    if (!isSafeExtensionName(extensionId)) {
      const entry = this.entry(extensionId, "invalid", undefined, [
        "Extension id contains unsafe path characters",
      ]);
      await this.persistEntry({ ...entry, source: "registry" });
      return entry;
    }

    const targetPath = path.join(this.root, extensionId);
    await fs.rm(targetPath, { recursive: true, force: true });
    await fs.mkdir(targetPath, { recursive: true });

    try {
      await extractZipBuffer(input.archiveBuffer, targetPath);
    } catch (error) {
      await fs.rm(targetPath, { recursive: true, force: true }).catch(() => undefined);
      const entry = this.entry(extensionId, "invalid", targetPath, [
        error instanceof Error ? error.message : String(error),
      ]);
      await this.persistEntry({ ...entry, source: "registry" });
      return entry;
    }

    const entry = await this.describeLocalExtension(extensionId);
    if (entry.status !== "available") {
      await fs.rm(targetPath, { recursive: true, force: true }).catch(() => undefined);
    }
    const registered = { ...entry, source: "registry" as const };
    await this.persistEntry(registered);
    return registered;
  }

  public async registerLocal(extensionId: string): Promise<ExtensionRegistryEntry> {
    if (!isSafeExtensionName(extensionId)) {
      const entry = this.entry(extensionId, "missing", undefined, [
        "Extension id contains unsafe path characters",
      ]);
      await this.persistEntry({ ...entry, source: "registry" });
      return entry;
    }

    const existing = await this.get(extensionId);
    if (!existing || existing.status === "missing") {
      const entry = this.entry(extensionId, "missing", path.join(this.root, extensionId), [
        "Extension directory does not exist",
      ]);
      await this.persistEntry({ ...entry, source: "registry" });
      return entry;
    }

    const registered = {
      ...existing,
      source: "registry" as const,
      updatedAt: new Date().toISOString(),
    };
    await this.persistEntry(registered);
    return registered;
  }

  private async describeLocalExtension(extensionId: string): Promise<ExtensionRegistryEntry> {
    const extensionPath = path.join(this.root, extensionId);
    const validation = await validateExtensionDirectory(extensionPath, this.root);

    if (!validation.valid)
      return this.entry(extensionId, "invalid", extensionPath, validation.errors);
    const manifest = validation.manifest ?? {};
    return this.entry(extensionId, "available", extensionPath, undefined, {
      name: typeof manifest.name === "string" ? manifest.name : undefined,
      version: typeof manifest.version === "string" ? manifest.version : undefined,
      manifestVersion:
        typeof manifest.manifest_version === "number" ? manifest.manifest_version : undefined,
    });
  }

  private async persistEntry(entry: ExtensionRegistryEntry): Promise<void> {
    await this.store.update((state) => {
      const existing = state.entries[entry.id];
      state.entries[entry.id] = {
        ...existing,
        ...entry,
        createdAt: existing?.createdAt ?? entry.createdAt,
        updatedAt: new Date().toISOString(),
      };
    });
  }

  private entry(
    id: string,
    status: ExtensionRegistryStatus,
    extensionPath?: string,
    errors?: string[],
    details?: Pick<ExtensionRegistryEntry, "name" | "version" | "manifestVersion">,
  ): ExtensionRegistryEntry {
    const now = new Date().toISOString();
    return {
      id,
      source: "local",
      status,
      path: extensionPath,
      errors,
      createdAt: now,
      updatedAt: now,
      ...details,
    };
  }
}
