export type SteelRole = "standalone" | "scheduler" | "worker";

export type WorkerLifecycleState = "ready" | "busy" | "draining" | "unhealthy";

export interface WorkerCapacity {
  maxSessions: number;
  configuredMaxSessions: number;
  activeSessions: number;
  availableSessions: number;
  acceptingSessions: boolean;
  draining: boolean;
  idleBrowser: boolean;
}

export interface WorkerHealth {
  id: string;
  role: SteelRole;
  status: WorkerLifecycleState;
  capacity: WorkerCapacity;
  heartbeatIntervalMs: number;
  drainTimeoutMs: number;
  updatedAt: string;
}

export interface WorkerRegistration {
  id: string;
  endpoint?: string;
  state: WorkerLifecycleState;
  capacity: WorkerCapacity;
  lastHeartbeatAt: string;
  metadata?: Record<string, unknown>;
}

export interface WorkerRegistry {
  register(worker: WorkerRegistration): Promise<WorkerRegistration>;
  heartbeat(worker: WorkerRegistration): Promise<WorkerRegistration>;
  get(workerId: string): Promise<WorkerRegistration | undefined>;
  list(): Promise<WorkerRegistration[]>;
  remove(workerId: string): Promise<boolean>;
  markDraining(workerId: string): Promise<WorkerRegistration | undefined>;
  pruneStale(now?: Date): Promise<string[]>;
}

export interface WorkerAllocationRequest {
  sessionId?: string;
  requiredSessions?: number;
  metadata?: Record<string, unknown>;
}

export type WorkerAllocationStatus = "allocated" | "unavailable" | "noop";

export interface WorkerAllocationResult {
  status: WorkerAllocationStatus;
  worker?: WorkerRegistration;
  reason?: string;
}

export interface WorkerAllocator {
  allocate(request?: WorkerAllocationRequest): Promise<WorkerAllocationResult>;
}
