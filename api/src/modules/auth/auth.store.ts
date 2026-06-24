import { JsonFileMetadataStore } from "../../services/metadata/index.js";
import type { ApiKeyRecord, AuditEvent, LocalUserRecord } from "./auth.types.js";
import { generateApiKey, sha256 } from "./crypto.js";

interface StoredAuthState {
  version?: 1;
  users?: LocalUserRecord[];
  apiKeys?: ApiKeyRecord[];
  audit?: AuditEvent[];
}

export interface CreateApiKeyInput {
  name?: string;
  subject: string;
  roles?: string[];
  permissions?: ApiKeyRecord["permissions"];
  tenantId?: string;
  orgId?: string;
  projectIds?: string[];
  expiresAt?: string;
}

export class AuthStore {
  private users: LocalUserRecord[] = [];
  private apiKeys: ApiKeyRecord[] = [];
  private audit: AuditEvent[] = [];

  private readonly store: JsonFileMetadataStore<StoredAuthState>;

  constructor(storePath?: string) {
    this.store = new JsonFileMetadataStore<StoredAuthState>({
      filePath: storePath,
      defaults: () => ({ version: 1, users: [], apiKeys: [], audit: [] }),
    });
  }

  static fromEnv(env: NodeJS.ProcessEnv, storePath?: string): AuthStore {
    const store = new AuthStore(storePath);
    store.loadFile();
    store.users.push(...parseJsonArray<LocalUserRecord>(env.STEEL_AUTH_USERS, "STEEL_AUTH_USERS"));
    if (env.STEEL_AUTH_LOCAL_ADMIN_EMAIL && env.STEEL_AUTH_LOCAL_ADMIN_PASSWORD) {
      store.users.push({
        id: "local-admin",
        email: env.STEEL_AUTH_LOCAL_ADMIN_EMAIL,
        password: env.STEEL_AUTH_LOCAL_ADMIN_PASSWORD,
        roles: ["admin"],
        tenantId: env.STEEL_DEFAULT_TENANT_ID || "default",
      });
    }

    const apiKeyRecords = parseJsonArray<ApiKeyRecord | (Partial<ApiKeyRecord> & { key?: string })>(
      env.STEEL_API_KEYS,
      "STEEL_API_KEYS",
    );
    for (const record of apiKeyRecords) {
      if ("key" in record && record.key) {
        store.apiKeys.push({
          id: record.id || record.key.slice(0, 12),
          name: record.name,
          keyHash: sha256(record.key),
          keyPrefix: record.key.slice(0, 12),
          subject: record.subject || record.id || "api-key",
          roles: record.roles || ["service"],
          permissions: record.permissions,
          tenantId: record.tenantId || env.STEEL_DEFAULT_TENANT_ID || "default",
          orgId: record.orgId,
          projectIds: record.projectIds,
          createdAt: record.createdAt || new Date().toISOString(),
          expiresAt: record.expiresAt,
          revokedAt: record.revokedAt,
        });
      } else if (record.keyHash) {
        store.apiKeys.push(record as ApiKeyRecord);
      }
    }

    if (env.STEEL_API_KEY) {
      store.apiKeys.push({
        id: "env-api-key",
        keyHash: sha256(env.STEEL_API_KEY),
        keyPrefix: env.STEEL_API_KEY.slice(0, 12),
        subject: "env-api-key",
        roles: ["admin"],
        tenantId: env.STEEL_DEFAULT_TENANT_ID || "default",
        createdAt: new Date().toISOString(),
      });
    }
    return store;
  }

  findUserByEmail(email: string): LocalUserRecord | undefined {
    return this.users.find((user) => user.email.toLowerCase() === email.toLowerCase());
  }

  findApiKey(rawKey: string): ApiKeyRecord | undefined {
    const hash = sha256(rawKey);
    const now = Date.now();
    return this.apiKeys.find((key) => {
      if (!key.keyHash || !key.keyPrefix || !rawKey.startsWith(key.keyPrefix)) return false;
      if (key.revokedAt) return false;
      if (key.expiresAt && Date.parse(key.expiresAt) < now) return false;
      return key.keyHash === hash;
    });
  }

  listApiKeys(): Omit<ApiKeyRecord, "keyHash">[] {
    return this.apiKeys.map(({ keyHash: _keyHash, ...safe }) => safe);
  }

  createApiKey(input: CreateApiKeyInput): { key: string; record: Omit<ApiKeyRecord, "keyHash"> } {
    const key = generateApiKey();
    const record: ApiKeyRecord = {
      id: `key_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      keyHash: sha256(key),
      keyPrefix: key.slice(0, 12),
      subject: input.subject,
      name: input.name,
      roles: input.roles || ["service"],
      permissions: input.permissions,
      tenantId: input.tenantId || "default",
      orgId: input.orgId,
      projectIds: input.projectIds,
      createdAt: new Date().toISOString(),
      expiresAt: input.expiresAt,
    };
    this.apiKeys.push(record);
    this.persist();
    const { keyHash: _keyHash, ...safe } = record;
    return { key, record: safe };
  }

  revokeApiKey(id: string): boolean {
    const record = this.apiKeys.find((key) => key.id === id);
    if (!record || record.revokedAt) return false;
    record.revokedAt = new Date().toISOString();
    this.persist();
    return true;
  }

  appendAudit(event: AuditEvent): void {
    this.audit.push(event);
    if (this.audit.length > 1000) this.audit.shift();
    this.persist();
  }

  getAuditEvents(): AuditEvent[] {
    return [...this.audit];
  }

  private loadFile(): void {
    const state = this.store.loadSync();
    this.users = state.users || [];
    this.apiKeys = state.apiKeys || [];
    this.audit = state.audit || [];
  }

  private persist(): void {
    this.store.saveSync({
      version: 1,
      users: this.users,
      apiKeys: this.apiKeys,
      audit: this.audit,
    });
  }
}

function parseJsonArray<T>(value: string | undefined, name: string): T[] {
  if (!value) return [];
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error(`${name} must be a JSON array`);
  return parsed as T[];
}
