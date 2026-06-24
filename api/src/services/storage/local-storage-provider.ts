import fs from "fs";
import path, { resolve } from "path";
import { pipeline } from "stream/promises";
import { JsonFileMetadataStore } from "../metadata/index.js";
import {
  CreateSignedUrlInput,
  GetObjectResult,
  InvalidStoragePathError,
  SaveObjectInput,
  SignedUrlNotSupportedError,
  SignedUrlResult,
  StorageNotFoundError,
  StorageObjectMetadata,
  StorageProvider,
} from "./storage-provider.js";

type PersistedObjectMetadata = Omit<StorageObjectMetadata, "lastModified"> & {
  lastModified: string;
};

type PersistedFileMetadata = {
  version: 1;
  objects: Record<string, PersistedObjectMetadata>;
};

export class LocalStorageProvider implements StorageProvider {
  public readonly type = "local" as const;
  private readonly rootPath: string;
  private readonly metadataStore: JsonFileMetadataStore<PersistedFileMetadata>;

  constructor(rootPath: string, metadataPath?: string) {
    this.rootPath = resolve(rootPath);
    fs.mkdirSync(this.rootPath, { recursive: true });
    this.metadataStore = new JsonFileMetadataStore<PersistedFileMetadata>({
      filePath: metadataPath,
      defaults: () => ({ version: 1, objects: {} }),
    });
  }

  public getRootPath(): string {
    return this.rootPath;
  }

  public getLocalPath(key = ""): string {
    return this.resolveKey(key);
  }

  public async saveObject(input: SaveObjectInput): Promise<StorageObjectMetadata> {
    const key = this.normalizeKey(input.key);
    const targetPath = this.resolveKey(key);
    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });

    await pipeline(input.stream, fs.createWriteStream(targetPath));
    const stats = await fs.promises.stat(targetPath);

    const object = {
      key,
      size: stats.size,
      lastModified: stats.mtime,
      contentType: input.contentType,
      metadata: input.metadata,
    } satisfies StorageObjectMetadata;
    await this.putMetadata(object);
    return object;
  }

  public async getObject(key: string): Promise<GetObjectResult> {
    const metadata = await this.headObject(key);
    return {
      ...metadata,
      stream: fs.createReadStream(this.resolveKey(metadata.key)),
    };
  }

  public async headObject(key: string): Promise<StorageObjectMetadata> {
    const normalizedKey = this.normalizeKey(key);
    const targetPath = this.resolveKey(normalizedKey);

    try {
      const stats = await fs.promises.stat(targetPath);
      if (!stats.isFile()) {
        throw new StorageNotFoundError(`File not found: ${normalizedKey}`);
      }
      return this.mergeStoredMetadata({
        key: normalizedKey,
        size: stats.size,
        lastModified: stats.mtime,
      });
    } catch (error: any) {
      if (error instanceof StorageNotFoundError) {
        throw error;
      }
      if (error?.code === "ENOENT") {
        throw new StorageNotFoundError(`File not found: ${normalizedKey}`);
      }
      throw error;
    }
  }

  public async listObjects(prefix = ""): Promise<StorageObjectMetadata[]> {
    const normalizedPrefix = prefix ? this.normalizeKey(prefix) : "";
    const startPath = this.resolveKey(normalizedPrefix);
    const objects: StorageObjectMetadata[] = [];

    if (!(await this.exists(startPath))) {
      return objects;
    }

    const startStats = await fs.promises.stat(startPath);
    if (startStats.isFile()) {
      objects.push(await this.headObject(normalizedPrefix));
      return objects;
    }

    const walk = async (dir: string) => {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(entryPath);
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }
        const stats = await fs.promises.stat(entryPath);
        objects.push(
          await this.mergeStoredMetadata({
            key: path.relative(this.rootPath, entryPath).split(path.sep).join("/"),
            size: stats.size,
            lastModified: stats.mtime,
          }),
        );
      }
    };

    await walk(startPath);
    objects.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
    return objects;
  }

  public async deleteObject(key: string): Promise<void> {
    const normalizedKey = this.normalizeKey(key);
    const targetPath = this.resolveKey(normalizedKey);
    await fs.promises.rm(targetPath, { force: true });
    await this.deleteMetadata(normalizedKey);
  }

  public async deletePrefix(prefix = ""): Promise<void> {
    const normalizedPrefix = prefix ? this.normalizeKey(prefix) : "";
    const targetPath = this.resolveKey(normalizedPrefix);
    if (targetPath === this.rootPath) {
      const entries = await fs.promises.readdir(this.rootPath).catch(() => []);
      await Promise.all(
        entries.map((entry) =>
          fs.promises.rm(path.join(this.rootPath, entry), { recursive: true, force: true }),
        ),
      );
      await this.deleteMetadataPrefix("");
      return;
    }
    await fs.promises.rm(targetPath, { recursive: true, force: true });
    await this.deleteMetadataPrefix(normalizedPrefix);
  }

  public async createSignedUrl(_input: CreateSignedUrlInput): Promise<SignedUrlResult> {
    throw new SignedUrlNotSupportedError(this.type);
  }

  private async mergeStoredMetadata(object: StorageObjectMetadata): Promise<StorageObjectMetadata> {
    const stored = (await this.metadataStore.load()).objects[object.key];
    if (!stored) return object;
    return {
      ...object,
      contentType: stored.contentType,
      metadata: stored.metadata,
    };
  }

  private async putMetadata(object: StorageObjectMetadata): Promise<void> {
    await this.metadataStore.update((state) => {
      state.objects[object.key] = {
        ...object,
        lastModified: object.lastModified.toISOString(),
      };
    });
  }

  private async deleteMetadata(key: string): Promise<void> {
    await this.metadataStore.update((state) => {
      delete state.objects[key];
    });
  }

  private async deleteMetadataPrefix(prefix: string): Promise<void> {
    await this.metadataStore.update((state) => {
      for (const key of Object.keys(state.objects)) {
        if (!prefix || key === prefix || key.startsWith(`${prefix}/`)) {
          delete state.objects[key];
        }
      }
    });
  }

  private normalizeKey(key: string): string {
    if (!key || key.includes("\0")) {
      throw new InvalidStoragePathError();
    }

    const normalized = path.posix.normalize(key.replace(/\\/g, "/"));
    if (
      normalized === "." ||
      normalized.startsWith("../") ||
      normalized === ".." ||
      path.posix.isAbsolute(normalized)
    ) {
      throw new InvalidStoragePathError();
    }

    return normalized;
  }

  private resolveKey(key = ""): string {
    const normalized = key ? this.normalizeKey(key) : "";
    const resolvedPath = resolve(this.rootPath, ...normalized.split("/").filter(Boolean));
    if (resolvedPath !== this.rootPath && !resolvedPath.startsWith(this.rootPath + path.sep)) {
      throw new InvalidStoragePathError();
    }
    return resolvedPath;
  }

  private async exists(filePath: string): Promise<boolean> {
    try {
      await fs.promises.stat(filePath);
      return true;
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }
}
