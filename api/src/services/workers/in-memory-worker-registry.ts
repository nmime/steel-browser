import { env } from "../../env.js";
import { JsonFileMetadataStore, resolveMetadataFilePath } from "../metadata/index.js";
import { WorkerRegistration, WorkerRegistry } from "./types.js";

const toTime = (value: string): number => {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
};

type PersistedWorkerRegistry = {
  version: 1;
  workers: Record<string, WorkerRegistration>;
};

export class InMemoryWorkerRegistry implements WorkerRegistry {
  private workers = new Map<string, WorkerRegistration>();
  private readonly store: JsonFileMetadataStore<PersistedWorkerRegistry>;

  constructor(
    private readonly staleAfterMs = env.WORKER_STALE_AFTER_MS,
    storePath = resolveMetadataFilePath(
      "workers",
      env.STEEL_WORKER_REGISTRY_STORE_PATH,
      env.STEEL_METADATA_STORE_PATH,
    ),
  ) {
    this.store = new JsonFileMetadataStore<PersistedWorkerRegistry>({
      filePath: storePath,
      defaults: () => ({ version: 1, workers: {} }),
    });
    this.loadPersisted();
  }

  async register(worker: WorkerRegistration): Promise<WorkerRegistration> {
    const existing = this.workers.get(worker.id);
    const next = {
      ...existing,
      ...worker,
      metadata: {
        ...(existing?.metadata ?? {}),
        ...(worker.metadata ?? {}),
      },
    } satisfies WorkerRegistration;
    this.workers.set(worker.id, next);
    await this.persist();
    return next;
  }

  async heartbeat(worker: WorkerRegistration): Promise<WorkerRegistration> {
    return this.register({
      ...worker,
      lastHeartbeatAt: worker.lastHeartbeatAt || new Date().toISOString(),
    });
  }

  async get(workerId: string): Promise<WorkerRegistration | undefined> {
    return this.workers.get(workerId);
  }

  async list(): Promise<WorkerRegistration[]> {
    return Array.from(this.workers.values()).sort((a, b) => a.id.localeCompare(b.id));
  }

  async remove(workerId: string): Promise<boolean> {
    const deleted = this.workers.delete(workerId);
    if (deleted) await this.persist();
    return deleted;
  }

  async markDraining(workerId: string): Promise<WorkerRegistration | undefined> {
    const worker = this.workers.get(workerId);
    if (!worker) return undefined;

    const next: WorkerRegistration = {
      ...worker,
      state: "draining",
      capacity: {
        ...worker.capacity,
        acceptingSessions: false,
        draining: true,
      },
    };
    this.workers.set(workerId, next);
    await this.persist();
    return next;
  }

  async pruneStale(now = new Date()): Promise<string[]> {
    const removed: string[] = [];
    const cutoff = now.getTime() - this.staleAfterMs;

    for (const [workerId, worker] of this.workers.entries()) {
      if (toTime(worker.lastHeartbeatAt) < cutoff) {
        this.workers.delete(workerId);
        removed.push(workerId);
      }
    }

    if (removed.length > 0) await this.persist();
    return removed;
  }

  private loadPersisted(): void {
    const persisted = this.store.loadSync();
    this.workers = new Map(Object.entries(persisted.workers ?? {}));
  }

  private async persist(): Promise<void> {
    await this.store.save({
      version: 1,
      workers: Object.fromEntries(this.workers),
    });
  }
}
