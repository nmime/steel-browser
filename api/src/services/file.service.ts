import archiver from "archiver";
import fs from "fs";
import { tmpdir } from "os";
import path from "path";
import { Readable } from "stream";
import { env } from "../env.js";
import {
  FileMetadata,
  FileMetadataService,
  FileQuotaConfig,
  FileQuotaService,
  LocalStorageProvider,
  SignedUrlOperation,
  SignedUrlResult,
  StorageProvider,
} from "./storage/index.js";
import { resolveMetadataFilePath } from "./metadata/index.js";

interface File {
  size: number;
  lastModified: Date;
}

export interface FileServiceConfig extends FileQuotaConfig {
  provider?: "local";
  localBasePath?: string;
  metadataStorePath?: string;
}

export class FileService {
  private baseFilesPath: string;
  private static instance: FileService | null = null;
  private prebuiltArchiveDir: string;
  private provider: StorageProvider;
  private localProvider: LocalStorageProvider | null = null;
  private metadataService = new FileMetadataService();
  private quotaService: FileQuotaService;

  private constructor(config: FileServiceConfig = {}) {
    const providerType = config.provider ?? env.STEEL_FILE_STORAGE_PROVIDER ?? "local";
    this.baseFilesPath =
      config.localBasePath ??
      env.STEEL_LOCAL_FILE_STORAGE_PATH ??
      (env.NODE_ENV === "development" || env.NODE_ENV === "test"
        ? path.join(tmpdir(), "files")
        : "/files");
    this.prebuiltArchiveDir = path.join(tmpdir(), ".steel");
    this.quotaService = new FileQuotaService({
      maxBytesPerSession: config.maxBytesPerSession ?? env.STEEL_FILE_STORAGE_MAX_BYTES_PER_SESSION,
      maxBytesPerFile: config.maxBytesPerFile ?? env.STEEL_FILE_STORAGE_MAX_BYTES_PER_FILE,
    });

    if (providerType !== "local") {
      throw new Error(`Unsupported file storage provider: ${providerType}`);
    }

    this.localProvider = new LocalStorageProvider(
      this.baseFilesPath,
      resolveMetadataFilePath(
        "files",
        config.metadataStorePath ?? env.STEEL_FILE_METADATA_STORE_PATH,
        env.STEEL_METADATA_STORE_PATH,
      ),
    );
    this.provider = this.localProvider;
  }

  public static getInstance(config?: FileServiceConfig) {
    if (!FileService.instance) {
      FileService.instance = new FileService(config);
    } else if (config) {
      FileService.instance.configure(config);
    }
    return FileService.instance;
  }

  public static createForTesting(config?: FileServiceConfig) {
    return new FileService(config);
  }

  public configure(config: FileServiceConfig) {
    this.quotaService.configure({
      maxBytesPerSession: config.maxBytesPerSession,
      maxBytesPerFile: config.maxBytesPerFile,
    });
  }

  public async saveFile({
    sessionId,
    filePath,
    stream,
    contentType,
  }: {
    sessionId?: string;
    filePath: string;
    stream: Readable;
    contentType?: string;
  }): Promise<FileMetadata> {
    const logicalPath = this.getSafeRelativePath(filePath);
    const key = this.getObjectKey(sessionId, logicalPath);
    const prefix = this.getSessionPrefix(sessionId);

    try {
      const object = await this.provider.saveObject({
        key,
        stream,
        contentType,
        metadata: sessionId ? { sessionId } : undefined,
      });

      await this.quotaService.assertObjectWithinQuota(object);
      await this.quotaService.assertPrefixWithinQuota(this.provider, prefix);

      return this.metadataService.toFileMetadata({
        object,
        path: logicalPath,
        sessionId,
        storageProvider: this.provider.type,
      });
    } catch (error) {
      await this.provider.deleteObject(key).catch(() => {});
      throw error;
    }
  }

  public async downloadFile({
    sessionId,
    filePath,
  }: {
    sessionId?: string;
    filePath: string;
  }): Promise<{ stream: Readable } & File> {
    const object = await this.provider.getObject(this.getObjectKey(sessionId, filePath));
    return {
      stream: object.stream,
      size: object.size,
      lastModified: object.lastModified,
    };
  }

  public async getFile({
    sessionId,
    filePath,
  }: {
    sessionId?: string;
    filePath: string;
  }): Promise<File> {
    const object = await this.provider.headObject(this.getObjectKey(sessionId, filePath));
    return {
      size: object.size,
      lastModified: object.lastModified,
    };
  }

  public async listFiles({ sessionId }: { sessionId?: string } = {}): Promise<FileMetadata[]> {
    const prefix = this.getSessionPrefix(sessionId);
    const objects = await this.provider.listObjects(prefix);

    return objects.map((object) =>
      this.metadataService.toFileMetadata({
        object,
        path: this.getLogicalPathFromKey(sessionId, object.key),
        sessionId,
        storageProvider: this.provider.type,
      }),
    );
  }

  public async deleteFile({
    sessionId,
    filePath,
  }: {
    sessionId?: string;
    filePath: string;
  }): Promise<void> {
    await this.provider.deleteObject(this.getObjectKey(sessionId, filePath));
  }

  public async cleanupFiles({ sessionId }: { sessionId?: string } = {}): Promise<void> {
    await this.provider.deletePrefix(this.getSessionPrefix(sessionId));
    await this.deleteArchive(sessionId).catch(() => {});
  }

  public async createSignedUrl({
    sessionId,
    filePath,
    operation,
    expiresInSeconds,
    contentType,
  }: {
    sessionId?: string;
    filePath: string;
    operation: SignedUrlOperation;
    expiresInSeconds?: number;
    contentType?: string;
  }): Promise<SignedUrlResult> {
    if (!this.provider.createSignedUrl) {
      throw new Error(`Storage provider ${this.provider.type} does not implement signed URLs`);
    }

    return this.provider.createSignedUrl({
      key: this.getObjectKey(sessionId, filePath),
      operation,
      expiresInSeconds,
      contentType,
    });
  }

  public getBaseFilesPath(): string {
    return this.baseFilesPath;
  }

  public async getPrebuiltArchivePath({ sessionId }: { sessionId?: string } = {}): Promise<string> {
    if (!this.localProvider) {
      throw new Error("Archive downloads are currently only implemented for local file storage");
    }

    await fs.promises.mkdir(this.prebuiltArchiveDir, { recursive: true });
    const archivePath = path.join(
      this.prebuiltArchiveDir,
      `files-${this.getArchiveName(sessionId)}.zip`,
    );
    const sourcePath = this.localProvider.getLocalPath(this.getSessionPrefix(sessionId));
    await this.createArchive(sourcePath, archivePath);
    return archivePath;
  }

  private async createArchive(sourcePath: string, archivePath: string): Promise<void> {
    const tempArchivePath = `${archivePath}.${Date.now()}.tmp`;

    await new Promise<void>((resolvePromise, rejectPromise) => {
      const output = fs.createWriteStream(tempArchivePath);
      const archive = archiver("zip", { zlib: { level: 9 } });
      let settled = false;

      const settle = (error?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        if (error) {
          rejectPromise(error);
        } else {
          resolvePromise();
        }
      };

      output.on("close", () => settle());
      output.on("error", (error) => settle(error));
      archive.on("error", (error) => settle(error));
      archive.on("warning", (error) => {
        if ((error as any).code !== "ENOENT") {
          settle(error);
        }
      });

      archive.pipe(output);

      try {
        if (fs.existsSync(sourcePath) && fs.statSync(sourcePath).isDirectory()) {
          archive.directory(sourcePath, false);
        }
        archive.finalize().catch((error) => settle(error));
      } catch (error: any) {
        settle(error instanceof Error ? error : new Error(String(error)));
      }
    });

    await fs.promises.rename(tempArchivePath, archivePath);
  }

  private async deleteArchive(sessionId?: string): Promise<void> {
    const archivePath = path.join(
      this.prebuiltArchiveDir,
      `files-${this.getArchiveName(sessionId)}.zip`,
    );
    await fs.promises.rm(archivePath, { force: true });
  }

  private getObjectKey(sessionId: string | undefined, filePath: string): string {
    const logicalPath = this.getSafeRelativePath(filePath);
    const prefix = this.getSessionPrefix(sessionId);
    return prefix ? `${prefix}/${logicalPath}` : logicalPath;
  }

  private getSessionPrefix(sessionId?: string): string {
    if (!sessionId) {
      return "global";
    }
    return `sessions/${this.getSafeSessionSegment(sessionId)}`;
  }

  private getLogicalPathFromKey(sessionId: string | undefined, key: string): string {
    const prefix = this.getSessionPrefix(sessionId);
    if (!prefix) {
      return key;
    }
    const prefixWithSlash = `${prefix}/`;
    return key.startsWith(prefixWithSlash) ? key.slice(prefixWithSlash.length) : key;
  }

  private getSafeSessionSegment(sessionId: string): string {
    const safeSegment = sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
    if (!safeSegment) {
      throw new Error("Invalid session id");
    }
    return safeSegment;
  }

  private getSafeRelativePath(filePath: string): string {
    if (!filePath || filePath.includes("\0")) {
      throw new Error("Invalid path");
    }

    const normalized = path.posix.normalize(filePath.replace(/\\/g, "/"));
    if (
      normalized === "." ||
      normalized.startsWith("../") ||
      normalized === ".." ||
      path.posix.isAbsolute(normalized)
    ) {
      throw new Error("Invalid path");
    }

    return normalized;
  }

  private getArchiveName(sessionId?: string): string {
    return sessionId ? this.getSafeSessionSegment(sessionId) : "root";
  }
}
