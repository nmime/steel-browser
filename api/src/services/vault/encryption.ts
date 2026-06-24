import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";

const AES_256_GCM = "aes-256-gcm" as const;
const IV_BYTES = 12;
const KEY_BYTES = 32;

export type KeyEncoding = "base64" | "hex" | "utf8";

export type EncryptedBlob = {
  algorithm: typeof AES_256_GCM;
  iv: string;
  ciphertext: string;
  authTag: string;
};

export type VaultEnvelope = {
  version: "v1";
  algorithm: typeof AES_256_GCM;
  keyEncryptionAlgorithm: typeof AES_256_GCM;
  encryptedDataKey: EncryptedBlob;
  payload: EncryptedBlob;
  createdAt: string;
};

export class VaultEncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultEncryptionError";
  }
}

export function decodeMasterKey(value: string): Buffer {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new VaultEncryptionError("Vault master key is empty");
  }

  const explicitPrefix = trimmed.match(/^(base64|hex|utf8):(.*)$/s);
  const candidates: Buffer[] = [];

  if (explicitPrefix) {
    const [, encoding, encoded] = explicitPrefix;
    candidates.push(Buffer.from(encoded, encoding as KeyEncoding));
  } else {
    if (/^[0-9a-f]{64}$/i.test(trimmed)) {
      candidates.push(Buffer.from(trimmed, "hex"));
    }
    candidates.push(Buffer.from(trimmed, "base64"));
    candidates.push(Buffer.from(trimmed, "utf8"));
  }

  for (const candidate of candidates) {
    if (candidate.length === KEY_BYTES) {
      return candidate;
    }
  }

  throw new VaultEncryptionError("Vault master key must decode to exactly 32 bytes");
}

export async function loadMasterKey(options: { key?: string; keyFile?: string }): Promise<Buffer> {
  if (options.key) {
    return decodeMasterKey(options.key);
  }

  if (options.keyFile) {
    const fileValue = await readFile(options.keyFile, "utf8");
    return decodeMasterKey(fileValue);
  }

  throw new VaultEncryptionError(
    "Vault master key is not configured; set STEEL_VAULT_MASTER_KEY or STEEL_VAULT_MASTER_KEY_FILE",
  );
}

export function encryptEnvelope(plaintext: string | Buffer, masterKey: Buffer): VaultEnvelope {
  assertKey(masterKey, "master key");

  const dataKey = randomBytes(KEY_BYTES);
  try {
    return {
      version: "v1",
      algorithm: AES_256_GCM,
      keyEncryptionAlgorithm: AES_256_GCM,
      encryptedDataKey: encryptBlob(dataKey, masterKey, Buffer.from("steel-vault:data-key:v1")),
      payload: encryptBlob(
        Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext, "utf8"),
        dataKey,
        Buffer.from("steel-vault:payload:v1"),
      ),
      createdAt: new Date().toISOString(),
    };
  } finally {
    dataKey.fill(0);
  }
}

export function decryptEnvelope(envelope: VaultEnvelope, masterKey: Buffer): Buffer {
  assertKey(masterKey, "master key");
  if (
    envelope.version !== "v1" ||
    envelope.algorithm !== AES_256_GCM ||
    envelope.keyEncryptionAlgorithm !== AES_256_GCM
  ) {
    throw new VaultEncryptionError("Unsupported vault envelope");
  }

  const dataKey = decryptBlob(
    envelope.encryptedDataKey,
    masterKey,
    Buffer.from("steel-vault:data-key:v1"),
  );
  try {
    assertKey(dataKey, "data key");
    return decryptBlob(envelope.payload, dataKey, Buffer.from("steel-vault:payload:v1"));
  } finally {
    dataKey.fill(0);
  }
}

function encryptBlob(plaintext: Buffer, key: Buffer, aad: Buffer): EncryptedBlob {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(AES_256_GCM, key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    algorithm: AES_256_GCM,
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

function decryptBlob(blob: EncryptedBlob, key: Buffer, aad: Buffer): Buffer {
  if (blob.algorithm !== AES_256_GCM) {
    throw new VaultEncryptionError("Unsupported encrypted blob algorithm");
  }

  const iv = Buffer.from(blob.iv, "base64");
  const ciphertext = Buffer.from(blob.ciphertext, "base64");
  const authTag = Buffer.from(blob.authTag, "base64");

  if (iv.length !== IV_BYTES || authTag.length !== 16) {
    throw new VaultEncryptionError("Invalid encrypted blob metadata");
  }

  const decipher = createDecipheriv(AES_256_GCM, key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function assertKey(key: Buffer, label: string) {
  const validLength = Buffer.from([key.length === KEY_BYTES ? 1 : 0]);
  const expected = Buffer.from([1]);
  if (!timingSafeEqual(validLength, expected)) {
    throw new VaultEncryptionError(`Invalid ${label} length`);
  }
}
