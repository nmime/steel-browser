import {
  StorageObjectMetadata,
  StorageProvider,
  StorageProviderError,
} from "./storage-provider.js";

export interface FileMetadata extends StorageObjectMetadata {
  sessionId?: string;
  path: string;
  storageProvider: string;
}

export interface FileQuotaConfig {
  maxBytesPerSession?: number;
  maxBytesPerFile?: number;
}

export class FileQuotaExceededError extends StorageProviderError {
  constructor(message: string) {
    super(message, 413);
    this.name = "FileQuotaExceededError";
  }
}

export class FileMetadataService {
  toFileMetadata({
    object,
    path,
    sessionId,
    storageProvider,
  }: {
    object: StorageObjectMetadata;
    path: string;
    sessionId?: string;
    storageProvider: string;
  }): FileMetadata {
    return {
      ...object,
      path,
      sessionId,
      storageProvider,
    };
  }
}

export class FileQuotaService {
  constructor(private config: FileQuotaConfig = {}) {}

  public configure(config: FileQuotaConfig) {
    this.config = { ...this.config, ...config };
  }

  public async assertObjectWithinQuota(object: StorageObjectMetadata) {
    if (this.config.maxBytesPerFile && object.size > this.config.maxBytesPerFile) {
      throw new FileQuotaExceededError(
        `File exceeds max file size quota (${object.size} > ${this.config.maxBytesPerFile})`,
      );
    }
  }

  public async assertPrefixWithinQuota(provider: StorageProvider, prefix: string) {
    if (!this.config.maxBytesPerSession) {
      return;
    }

    const usage = await this.getUsageBytes(provider, prefix);
    if (usage > this.config.maxBytesPerSession) {
      throw new FileQuotaExceededError(
        `Session storage quota exceeded (${usage} > ${this.config.maxBytesPerSession})`,
      );
    }
  }

  public async getUsageBytes(provider: StorageProvider, prefix: string): Promise<number> {
    const objects = await provider.listObjects(prefix);
    return objects.reduce((total, object) => total + object.size, 0);
  }
}
