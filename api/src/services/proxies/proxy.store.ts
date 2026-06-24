import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import { env } from "../../env.js";
import { normalizeProxyUrl, redactProxyUrl } from "../../utils/proxy-url.js";
import { redactSensitiveData } from "../../utils/redaction.js";

export type ManagedProxyStatus = "active" | "disabled";
export type ManagedProxyHealthStatus = "unknown" | "healthy" | "unhealthy";
export type ProxyPoolStrategy = "round_robin" | "least_leased" | "random";
export type ProxyLeaseState = "active" | "released";

export type ManagedProxyHealth = {
  status: ManagedProxyHealthStatus;
  checkedAt?: string;
  message?: string;
};

export type ManagedProxyRecord = {
  id: string;
  name?: string;
  url: string;
  status: ManagedProxyStatus;
  metadata: Record<string, unknown>;
  health: ManagedProxyHealth;
  createdAt: string;
  updatedAt: string;
};

export type ManagedProxyMetadata = Omit<ManagedProxyRecord, "url"> & { url: string };

export type ManagedProxyInput = {
  id?: string;
  name?: string;
  url?: string;
  status?: ManagedProxyStatus;
  metadata?: Record<string, unknown>;
};

export type ProxyPoolRecord = {
  id: string;
  name?: string;
  proxyIds: string[];
  strategy: ProxyPoolStrategy;
  metadata: Record<string, unknown>;
  cursor: number;
  createdAt: string;
  updatedAt: string;
};

export type ProxyPoolInput = {
  id?: string;
  name?: string;
  proxyIds?: string[];
  strategy?: ProxyPoolStrategy;
  metadata?: Record<string, unknown>;
};

export type ProxyLeaseRecord = {
  id: string;
  proxyId: string;
  poolId?: string;
  sessionId?: string;
  state: ProxyLeaseState;
  ttlSeconds?: number;
  expiresAt?: string;
  createdAt: string;
  releasedAt?: string;
};

export type ProxyLeaseMetadata = ProxyLeaseRecord & {
  proxy?: ManagedProxyMetadata;
};

export type ProxyLeaseInput = {
  poolId?: string;
  proxyId?: string;
  sessionId?: string;
  ttlSeconds?: number;
};

type PersistedProxyInventory = {
  version: 1;
  proxies: Record<string, ManagedProxyRecord>;
  pools: Record<string, ProxyPoolRecord>;
  leases: Record<string, ProxyLeaseRecord>;
};

export class ProxyStoreError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 400,
  ) {
    super(message);
  }
}

export class ProxyStore {
  private proxies = new Map<string, ManagedProxyRecord>();
  private pools = new Map<string, ProxyPoolRecord>();
  private leases = new Map<string, ProxyLeaseRecord>();
  private loaded = false;

  constructor(private readonly options: { filePath?: string } = {}) {}

  async listProxies(): Promise<ManagedProxyMetadata[]> {
    await this.load();
    return Array.from(this.proxies.values()).map(toProxyMetadata);
  }

  async getProxy(id: string): Promise<ManagedProxyMetadata | undefined> {
    await this.load();
    const proxy = this.proxies.get(id);
    return proxy ? toProxyMetadata(proxy) : undefined;
  }

  async getProxyUrl(id: string): Promise<string | undefined> {
    await this.load();
    return this.proxies.get(id)?.url;
  }

  async upsertProxy(input: ManagedProxyInput): Promise<ManagedProxyMetadata> {
    await this.load();
    const now = new Date().toISOString();
    const existing = input.id ? this.proxies.get(input.id) : undefined;
    if (!existing && !input.url) {
      throw new ProxyStoreError("Proxy url is required", 400);
    }

    const id = input.id || uuidv4();
    const proxy: ManagedProxyRecord = {
      id,
      name: input.name ?? existing?.name,
      url: input.url ? normalizeProxyUrl(input.url) : existing!.url,
      status: input.status ?? existing?.status ?? "active",
      metadata: redactSensitiveData(input.metadata ?? existing?.metadata ?? {}),
      health: existing?.health ?? { status: "unknown" },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.proxies.set(id, proxy);
    await this.persist();
    return toProxyMetadata(proxy);
  }

  async deleteProxy(id: string): Promise<boolean> {
    await this.load();
    if (this.activeLeases().some((lease) => lease.proxyId === id)) {
      throw new ProxyStoreError("Cannot delete proxy with active leases", 409);
    }

    const deleted = this.proxies.delete(id);
    if (!deleted) return false;

    for (const [poolId, pool] of this.pools.entries()) {
      if (pool.proxyIds.includes(id)) {
        this.pools.set(poolId, {
          ...pool,
          proxyIds: pool.proxyIds.filter((proxyId) => proxyId !== id),
          updatedAt: new Date().toISOString(),
        });
      }
    }
    await this.persist();
    return true;
  }

  async healthCheckProxy(id: string): Promise<ManagedProxyMetadata | undefined> {
    await this.load();
    const proxy = this.proxies.get(id);
    if (!proxy) return undefined;

    const now = new Date().toISOString();
    const next: ManagedProxyRecord = {
      ...proxy,
      health: {
        status: "unknown",
        checkedAt: now,
        message: "Health check stub recorded; active network probing is not implemented.",
      },
      updatedAt: now,
    };
    this.proxies.set(id, next);
    await this.persist();
    return toProxyMetadata(next);
  }

  async listPools(): Promise<ProxyPoolRecord[]> {
    await this.load();
    return Array.from(this.pools.values()).map(toPoolMetadata);
  }

  async getPool(id: string): Promise<ProxyPoolRecord | undefined> {
    await this.load();
    const pool = this.pools.get(id);
    return pool ? toPoolMetadata(pool) : undefined;
  }

  async upsertPool(input: ProxyPoolInput): Promise<ProxyPoolRecord> {
    await this.load();
    const now = new Date().toISOString();
    const existing = input.id ? this.pools.get(input.id) : undefined;
    const proxyIds = input.proxyIds ?? existing?.proxyIds ?? [];
    for (const proxyId of proxyIds) {
      if (!this.proxies.has(proxyId)) {
        throw new ProxyStoreError(`Proxy ${proxyId} was not found`, 400);
      }
    }

    const pool: ProxyPoolRecord = {
      id: input.id || uuidv4(),
      name: input.name ?? existing?.name,
      proxyIds,
      strategy: input.strategy ?? existing?.strategy ?? "round_robin",
      metadata: redactSensitiveData(input.metadata ?? existing?.metadata ?? {}),
      cursor: existing?.cursor ?? 0,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.pools.set(pool.id, pool);
    await this.persist();
    return toPoolMetadata(pool);
  }

  async deletePool(id: string): Promise<boolean> {
    await this.load();
    if (this.activeLeases().some((lease) => lease.poolId === id)) {
      throw new ProxyStoreError("Cannot delete proxy pool with active leases", 409);
    }
    const deleted = this.pools.delete(id);
    if (deleted) await this.persist();
    return deleted;
  }

  async listLeases(): Promise<ProxyLeaseMetadata[]> {
    await this.load();
    await this.releaseExpiredLeases();
    return Array.from(this.leases.values()).map((lease) => this.toLeaseMetadata(lease));
  }

  async getLease(id: string): Promise<ProxyLeaseMetadata | undefined> {
    await this.load();
    await this.releaseExpiredLeases();
    const lease = this.leases.get(id);
    return lease ? this.toLeaseMetadata(lease) : undefined;
  }

  async getLeaseProxyUrl(id: string): Promise<string | undefined> {
    await this.load();
    await this.releaseExpiredLeases();
    const lease = this.leases.get(id);
    if (!lease || lease.state !== "active") return undefined;
    const proxy = this.proxies.get(lease.proxyId);
    return proxy?.status === "active" ? proxy.url : undefined;
  }

  async acquireLease(input: ProxyLeaseInput): Promise<ProxyLeaseMetadata> {
    await this.load();
    await this.releaseExpiredLeases();
    const proxyId = input.proxyId ?? this.allocateProxyFromPool(input.poolId);
    const proxy = this.proxies.get(proxyId);
    if (!proxy) {
      throw new ProxyStoreError("Proxy was not found", 404);
    }
    if (proxy.status !== "active") {
      throw new ProxyStoreError("Proxy is disabled", 409);
    }

    const now = new Date().toISOString();
    const lease: ProxyLeaseRecord = {
      id: uuidv4(),
      proxyId,
      poolId: input.poolId,
      sessionId: input.sessionId,
      state: "active",
      ttlSeconds: input.ttlSeconds,
      expiresAt: input.ttlSeconds
        ? new Date(Date.now() + input.ttlSeconds * 1000).toISOString()
        : undefined,
      createdAt: now,
    };

    this.leases.set(lease.id, lease);
    await this.persist();
    return this.toLeaseMetadata(lease);
  }

  async assignLeaseSession(
    leaseId: string,
    sessionId: string,
  ): Promise<ProxyLeaseMetadata | undefined> {
    await this.load();
    const lease = this.leases.get(leaseId);
    if (!lease || lease.state !== "active") return undefined;
    const next = { ...lease, sessionId };
    this.leases.set(leaseId, next);
    await this.persist();
    return this.toLeaseMetadata(next);
  }

  async releaseLease(id: string): Promise<ProxyLeaseMetadata | undefined> {
    await this.load();
    const lease = this.leases.get(id);
    if (!lease) return undefined;
    const released = this.releaseLeaseRecord(lease);
    this.leases.set(id, released);
    await this.persist();
    return this.toLeaseMetadata(released);
  }

  async releaseLeasesForSession(sessionId: string): Promise<ProxyLeaseMetadata[]> {
    await this.load();
    const released: ProxyLeaseRecord[] = [];
    for (const lease of this.leases.values()) {
      if (lease.sessionId === sessionId && lease.state === "active") {
        const next = this.releaseLeaseRecord(lease);
        this.leases.set(lease.id, next);
        released.push(next);
      }
    }
    if (released.length) await this.persist();
    return released.map((lease) => this.toLeaseMetadata(lease));
  }

  private allocateProxyFromPool(poolId?: string): string {
    if (!poolId) {
      throw new ProxyStoreError("poolId or proxyId is required", 400);
    }

    const pool = this.pools.get(poolId);
    if (!pool) {
      throw new ProxyStoreError("Proxy pool was not found", 404);
    }

    const candidates = pool.proxyIds.filter(
      (proxyId) => this.proxies.get(proxyId)?.status === "active",
    );
    if (!candidates.length) {
      throw new ProxyStoreError("Proxy pool has no active proxies", 409);
    }

    if (pool.strategy === "random") {
      return candidates[Math.floor(Math.random() * candidates.length)];
    }

    if (pool.strategy === "least_leased") {
      const activeCounts = new Map<string, number>();
      for (const lease of this.activeLeases()) {
        activeCounts.set(lease.proxyId, (activeCounts.get(lease.proxyId) ?? 0) + 1);
      }
      return candidates.sort(
        (a, b) => (activeCounts.get(a) ?? 0) - (activeCounts.get(b) ?? 0) || a.localeCompare(b),
      )[0];
    }

    const index = pool.cursor % candidates.length;
    const selected = candidates[index];
    this.pools.set(pool.id, { ...pool, cursor: (index + 1) % candidates.length });
    return selected;
  }

  private activeLeases(): ProxyLeaseRecord[] {
    const now = Date.now();
    return Array.from(this.leases.values()).filter((lease) => {
      if (lease.state !== "active") return false;
      return !lease.expiresAt || Date.parse(lease.expiresAt) > now;
    });
  }

  private async releaseExpiredLeases(): Promise<void> {
    let changed = false;
    for (const [id, lease] of this.leases.entries()) {
      if (
        lease.state === "active" &&
        lease.expiresAt &&
        Date.parse(lease.expiresAt) <= Date.now()
      ) {
        this.leases.set(id, this.releaseLeaseRecord(lease));
        changed = true;
      }
    }
    if (changed) await this.persist();
  }

  private releaseLeaseRecord(lease: ProxyLeaseRecord): ProxyLeaseRecord {
    if (lease.state === "released") return lease;
    return { ...lease, state: "released", releasedAt: new Date().toISOString() };
  }

  private toLeaseMetadata(lease: ProxyLeaseRecord): ProxyLeaseMetadata {
    const proxy = this.proxies.get(lease.proxyId);
    return {
      ...lease,
      proxy: proxy ? toProxyMetadata(proxy) : undefined,
    };
  }

  private async load() {
    if (this.loaded) return;
    this.loaded = true;
    const filePath = this.options.filePath ?? env.STEEL_PROXY_STORE_PATH;
    if (!filePath) return;

    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8")) as PersistedProxyInventory;
      this.proxies = new Map(Object.entries(parsed.proxies ?? {}));
      this.pools = new Map(Object.entries(parsed.pools ?? {}));
      this.leases = new Map(Object.entries(parsed.leases ?? {}));
    } catch (error: any) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }

  private async persist() {
    const filePath = this.options.filePath ?? env.STEEL_PROXY_STORE_PATH;
    if (!filePath) return;

    await mkdir(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    const payload: PersistedProxyInventory = {
      version: 1,
      proxies: Object.fromEntries(this.proxies),
      pools: Object.fromEntries(this.pools),
      leases: Object.fromEntries(this.leases),
    };
    await writeFile(tmpPath, JSON.stringify(payload, null, 2), { mode: 0o600 });
    await rename(tmpPath, filePath);
  }
}

export function toProxyMetadata(proxy: ManagedProxyRecord): ManagedProxyMetadata {
  return {
    ...proxy,
    url: redactProxyUrl(proxy.url) ?? proxy.url,
    metadata: redactSensitiveData(proxy.metadata),
  };
}

export function toPoolMetadata(pool: ProxyPoolRecord): ProxyPoolRecord {
  return {
    ...pool,
    proxyIds: [...pool.proxyIds],
    metadata: redactSensitiveData(pool.metadata),
  };
}

export const managedProxyStore = new ProxyStore();
