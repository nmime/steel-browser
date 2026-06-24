import { Readable } from "stream";

export type StorageProviderType = "local";
export type SignedUrlOperation = "read" | "write";

export interface StorageObjectMetadata {
  key: string;
  size: number;
  lastModified: Date;
  contentType?: string;
  etag?: string;
  metadata?: Record<string, string>;
}

export interface SaveObjectInput {
  key: string;
  stream: Readable;
  contentType?: string;
  metadata?: Record<string, string>;
}

export interface GetObjectResult extends StorageObjectMetadata {
  stream: Readable;
}

export interface CreateSignedUrlInput {
  key: string;
  operation: SignedUrlOperation;
  expiresInSeconds?: number;
  contentType?: string;
}

export interface SignedUrlResult {
  url: string;
  method: "GET" | "PUT" | "POST";
  expiresAt: Date;
  headers?: Record<string, string>;
}

export interface StorageProvider {
  readonly type: StorageProviderType;
  saveObject(input: SaveObjectInput): Promise<StorageObjectMetadata>;
  getObject(key: string): Promise<GetObjectResult>;
  headObject(key: string): Promise<StorageObjectMetadata>;
  listObjects(prefix?: string): Promise<StorageObjectMetadata[]>;
  deleteObject(key: string): Promise<void>;
  deletePrefix(prefix?: string): Promise<void>;
  createSignedUrl?(input: CreateSignedUrlInput): Promise<SignedUrlResult>;
}

export class StorageProviderError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 500,
  ) {
    super(message);
    this.name = "StorageProviderError";
  }
}

export class StorageNotFoundError extends StorageProviderError {
  constructor(message: string) {
    super(message, 404);
    this.name = "StorageNotFoundError";
  }
}

export class InvalidStoragePathError extends StorageProviderError {
  constructor(message = "Invalid storage path") {
    super(message, 400);
    this.name = "InvalidStoragePathError";
  }
}

export class SignedUrlNotSupportedError extends StorageProviderError {
  constructor(providerType: StorageProviderType) {
    super(`Signed URLs are not supported by the ${providerType} storage provider`, 501);
    this.name = "SignedUrlNotSupportedError";
  }
}
