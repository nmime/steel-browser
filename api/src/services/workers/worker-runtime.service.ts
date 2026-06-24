import { env } from "../../env.js";
import { SessionDetails } from "../../modules/sessions/sessions.schema.js";
import { SteelRole, WorkerCapacity, WorkerHealth, WorkerLifecycleState } from "./types.js";

const toPositiveInteger = (value: number, fallback: number): number =>
  Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;

export class WorkerCapacityExceededError extends Error {
  constructor(message = "Worker has no available session capacity") {
    super(message);
    this.name = "WorkerCapacityExceededError";
  }
}

export class WorkerDrainingError extends Error {
  constructor(message = "Worker is draining and is not accepting new sessions") {
    super(message);
    this.name = "WorkerDrainingError";
  }
}

export interface WorkerRuntimeConfig {
  role?: SteelRole;
  workerId?: string;
  maxSessions?: number;
  idleBrowser?: boolean;
  heartbeatIntervalMs?: number;
  drainTimeoutMs?: number;
}

export class WorkerRuntimeService {
  public readonly workerId: string;
  public readonly role: SteelRole;
  public readonly configuredMaxSessions: number;
  public readonly maxSessions: number;
  public readonly idleBrowser: boolean;
  public readonly heartbeatIntervalMs: number;
  public readonly drainTimeoutMs: number;
  private draining = false;
  private drainStartedAt?: string;

  constructor(config: WorkerRuntimeConfig = {}) {
    this.role = config.role ?? env.STEEL_ROLE;
    this.workerId =
      config.workerId ?? process.env.WORKER_ID ?? process.env.HOSTNAME ?? "local-worker";
    this.configuredMaxSessions = toPositiveInteger(
      config.maxSessions ?? env.WORKER_MAX_SESSIONS,
      1,
    );
    // The current browser runtime owns one mutable activeSession, so worker mode advertises
    // and enforces one session even if the future scheduler config is raised above 1.
    this.maxSessions =
      this.role === "worker" ? Math.min(this.configuredMaxSessions, 1) : this.configuredMaxSessions;
    this.idleBrowser = config.idleBrowser ?? env.WORKER_IDLE_BROWSER;
    this.heartbeatIntervalMs = toPositiveInteger(
      config.heartbeatIntervalMs ?? env.WORKER_HEARTBEAT_INTERVAL_MS,
      5000,
    );
    this.drainTimeoutMs = toPositiveInteger(
      config.drainTimeoutMs ?? env.WORKER_DRAIN_TIMEOUT_MS,
      30000,
    );
  }

  startDraining(): WorkerHealth {
    this.draining = true;
    this.drainStartedAt = new Date().toISOString();
    return this.getHealth();
  }

  stopDraining(): WorkerHealth {
    this.draining = false;
    this.drainStartedAt = undefined;
    return this.getHealth();
  }

  isDraining(): boolean {
    return this.draining;
  }

  getDrainStartedAt(): string | undefined {
    return this.drainStartedAt;
  }

  getCapacity(activeSession?: Pick<SessionDetails, "status">): WorkerCapacity {
    const activeSessions = activeSession?.status === "live" ? 1 : 0;
    const availableSessions = Math.max(this.maxSessions - activeSessions, 0);
    return {
      maxSessions: this.maxSessions,
      configuredMaxSessions: this.configuredMaxSessions,
      activeSessions,
      availableSessions,
      acceptingSessions: this.role !== "worker" || (!this.draining && availableSessions > 0),
      draining: this.draining,
      idleBrowser: this.idleBrowser,
    };
  }

  getHealth(activeSession?: Pick<SessionDetails, "status">, browserRunning = true): WorkerHealth {
    const capacity = this.getCapacity(activeSession);
    let status: WorkerLifecycleState = "ready";
    if (!browserRunning && this.idleBrowser) status = "unhealthy";
    else if (capacity.draining) status = "draining";
    else if (capacity.availableSessions === 0) status = "busy";

    return {
      id: this.workerId,
      role: this.role,
      status,
      capacity,
      heartbeatIntervalMs: this.heartbeatIntervalMs,
      drainTimeoutMs: this.drainTimeoutMs,
      updatedAt: new Date().toISOString(),
    };
  }

  assertCanStartSession(activeSession?: Pick<SessionDetails, "status">): void {
    if (this.role !== "worker") return;
    if (this.draining) throw new WorkerDrainingError();
    if (this.getCapacity(activeSession).availableSessions <= 0) {
      throw new WorkerCapacityExceededError();
    }
  }
}
