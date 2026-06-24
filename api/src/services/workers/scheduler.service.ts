import type { FastifyReply, FastifyRequest } from "fastify";
import http from "node:http";
import https from "node:https";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";
import { env } from "../../env.js";
import { getErrors } from "../../utils/errors.js";
import {
  WorkerAllocationRequest,
  WorkerAllocationResult,
  WorkerRegistration,
  WorkerRegistry,
} from "./types.js";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

export interface SessionWorkerMapping {
  sessionId: string;
  workerId: string;
  endpoint: string;
  allocatedAt: string;
  lastRoutedAt?: string;
  recovery?: SessionRecoveryStatus;
}

export type SessionRecoveryState = "live" | "interrupted" | "recovering" | "recovered" | "failed";

export interface SessionRecoveryStatus {
  state: SessionRecoveryState;
  reason?: string;
  interruptedAt?: string;
  recoveryStartedAt?: string;
  recoveredAt?: string;
  failedAt?: string;
  sourceWorkerId?: string;
  replacementWorkerId?: string;
  attempts: number;
  canRecover: boolean;
  restoredFrom?: Array<"profile" | "sessionContext" | "userDataDir" | "files" | "none">;
  lastError?: string;
}

export interface SessionRecoveryEvent {
  type:
    | "session_interrupted"
    | "session_recovering"
    | "session_recovered"
    | "session_recovery_failed";
  sessionId: string;
  workerId?: string;
  replacementWorkerId?: string;
  timestamp: string;
  reason?: string;
  recovery: SessionRecoveryStatus;
}

export interface SchedulerRecoveryPolicy {
  enabled: boolean;
  autoAllocate: boolean;
  maxAttempts: number;
}

export interface SchedulerServiceConfig {
  recoveryEnabled?: boolean;
  recoveryAutoAllocate?: boolean;
  recoveryMaxAttempts?: number;
}

export interface SchedulerAllocation extends WorkerAllocationResult {
  sessionId?: string;
  mapping?: SessionWorkerMapping;
}

export interface SchedulerProxyResult {
  proxied: boolean;
  reason?: string;
}

interface ProxyTarget {
  mapping: SessionWorkerMapping;
  releaseAfterSuccess?: boolean;
}

export interface StaleWorkerRecoveryResult {
  staleWorkerIds: string[];
  affectedSessions: SessionWorkerMapping[];
}

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, "");

const isObjectBody = (body: unknown): body is Record<string, unknown> =>
  !!body && typeof body === "object" && !Buffer.isBuffer(body);

function sessionIdFromPath(pathname: string): string | undefined {
  const match = pathname.match(/^\/v1\/sessions\/([^/]+)(?:\/|$)/);
  if (!match) return undefined;
  const id = decodeURIComponent(match[1]);
  return id === "debug" || id === "cast" || id === "release" ? undefined : id;
}

function sessionIdFromRequest(request: FastifyRequest): string | undefined {
  const url = new URL(request.raw.url ?? request.url, "http://steel.local");
  const pathSessionId = sessionIdFromPath(url.pathname);
  if (pathSessionId) return pathSessionId;

  const querySessionId = url.searchParams.get("sessionId");
  if (querySessionId) return querySessionId;

  const headerSessionId = request.headers["x-steel-session-id"];
  if (Array.isArray(headerSessionId)) return headerSessionId[0];
  if (typeof headerSessionId === "string" && headerSessionId) return headerSessionId;

  if (isObjectBody(request.body) && typeof request.body.sessionId === "string") {
    return request.body.sessionId;
  }

  return undefined;
}

function bodyForFetch(request: FastifyRequest): BodyInit | undefined {
  if (["GET", "HEAD"].includes(request.method.toUpperCase())) return undefined;
  const body = request.body;
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return body;
  if (Buffer.isBuffer(body)) return body as unknown as BodyInit;
  if (body instanceof ArrayBuffer) return body;
  return JSON.stringify(body);
}

function headersForFetch(request: FastifyRequest): HeadersInit {
  const headers: Record<string, string> = {};
  for (const [name, rawValue] of Object.entries(request.headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    if (rawValue === undefined) continue;
    headers[name] = Array.isArray(rawValue) ? rawValue.join(", ") : String(rawValue);
  }

  if (isObjectBody(request.body) && !headers["content-type"] && !headers["Content-Type"]) {
    headers["content-type"] = "application/json";
  }
  headers["x-steel-scheduler"] = "1";
  return headers;
}

function schedulerBaseUrl(request: FastifyRequest, protocol: "http" | "ws" = "http"): string {
  const host = request.headers["x-forwarded-host"] ?? request.headers.host ?? "localhost";
  const rawProto = request.headers["x-forwarded-proto"];
  const httpProto = Array.isArray(rawProto) ? rawProto[0] : rawProto;
  const resolvedHttpProto = httpProto === "https" ? "https" : "http";
  const resolvedProtocol =
    protocol === "ws" ? (resolvedHttpProto === "https" ? "wss" : "ws") : resolvedHttpProto;
  return `${resolvedProtocol}://${Array.isArray(host) ? host[0] : host}`;
}

function rewriteSessionUrls(value: unknown, request: FastifyRequest): unknown {
  if (!isObjectBody(value)) return value;
  const httpBase = schedulerBaseUrl(request, "http");
  const wsBase = schedulerBaseUrl(request, "ws");
  return {
    ...value,
    websocketUrl: value.websocketUrl ? wsBase : value.websocketUrl,
    debugUrl: value.debugUrl ? `${httpBase}/v1/sessions/debug` : value.debugUrl,
    debuggerUrl: value.debuggerUrl ? `${httpBase}/v1/devtools/inspector.html` : value.debuggerUrl,
    sessionViewerUrl: value.sessionViewerUrl ? httpBase : value.sessionViewerUrl,
  };
}

function recoveryStatusForMapping(mapping: SessionWorkerMapping): SessionRecoveryStatus {
  return (
    mapping.recovery ?? {
      state: "live",
      attempts: 0,
      canRecover: false,
      sourceWorkerId: mapping.workerId,
    }
  );
}

function attachRecoveryStatus(value: unknown, mapping: SessionWorkerMapping): unknown {
  if (!isObjectBody(value)) return value;
  return { ...value, recovery: recoveryStatusForMapping(mapping) };
}

function canProxyMapping(mapping: SessionWorkerMapping): boolean {
  const state = mapping.recovery?.state;
  return !state || state === "live" || state === "recovered";
}

function restoredFrom(
  body: Record<string, unknown> | undefined,
): SessionRecoveryStatus["restoredFrom"] {
  if (!body) return ["none"];
  const sources = new Set<"profile" | "sessionContext" | "userDataDir" | "files" | "none">();
  if (typeof body.profileId === "string") sources.add("profile");
  if (isObjectBody(body.sessionContext)) sources.add("sessionContext");
  if (typeof body.userDataDir === "string" || body.persist === true) sources.add("userDataDir");
  if (Array.isArray(body.files) || isObjectBody(body.fileStorage)) sources.add("files");
  if (sources.size === 0) sources.add("none");
  return Array.from(sources);
}

export class SchedulerService {
  private readonly sessionWorkers = new Map<string, SessionWorkerMapping>();
  private readonly sessionRecoveryInputs = new Map<string, Record<string, unknown>>();
  private readonly recoveryEvents: SessionRecoveryEvent[] = [];
  private readonly recoveryPolicy: SchedulerRecoveryPolicy;

  constructor(
    private readonly registry: WorkerRegistry,
    config: SchedulerServiceConfig = {},
  ) {
    this.recoveryPolicy = {
      enabled: config.recoveryEnabled ?? env.STEEL_SESSION_RECOVERY_ENABLED,
      autoAllocate: config.recoveryAutoAllocate ?? env.STEEL_SESSION_RECOVERY_AUTO_ALLOCATE,
      maxAttempts: Math.max(
        1,
        Math.floor(config.recoveryMaxAttempts ?? env.STEEL_SESSION_RECOVERY_MAX_ATTEMPTS),
      ),
    };
  }

  getRecoveryPolicy(): SchedulerRecoveryPolicy {
    return { ...this.recoveryPolicy };
  }

  getRecoveryEvents(): SessionRecoveryEvent[] {
    return [...this.recoveryEvents];
  }

  async registerWorker(worker: WorkerRegistration): Promise<WorkerRegistration> {
    const normalized: WorkerRegistration = {
      ...worker,
      endpoint: worker.endpoint ? trimTrailingSlash(worker.endpoint) : worker.endpoint,
      lastHeartbeatAt: worker.lastHeartbeatAt || new Date().toISOString(),
    };
    return this.registry.heartbeat(normalized);
  }

  async allocate(request: WorkerAllocationRequest = {}): Promise<SchedulerAllocation> {
    await this.recoverStaleWorkers();

    if (request.sessionId) {
      const existing = this.sessionWorkers.get(request.sessionId);
      if (existing) {
        const worker = await this.registry.get(existing.workerId);
        return {
          status: worker ? "allocated" : "unavailable",
          worker,
          sessionId: request.sessionId,
          mapping: existing,
          reason: worker
            ? "Session is already assigned to a worker."
            : "Assigned worker is no longer registered.",
        };
      }
    }

    const worker = await this.findAvailableWorker();

    if (!worker) {
      return {
        status: "unavailable",
        reason: "No registered worker currently has available capacity.",
      };
    }

    const sessionId = request.sessionId ?? randomUUID();
    const mapping = this.assignSession(sessionId, worker);
    return {
      status: "allocated",
      worker,
      sessionId,
      mapping,
      reason: "Allocated an idle worker for the session.",
    };
  }

  assignSession(sessionId: string, worker: WorkerRegistration): SessionWorkerMapping {
    if (!worker.endpoint) throw new Error(`Worker ${worker.id} has no endpoint`);
    const mapping: SessionWorkerMapping = {
      sessionId,
      workerId: worker.id,
      endpoint: trimTrailingSlash(worker.endpoint),
      allocatedAt: new Date().toISOString(),
    };
    this.sessionWorkers.set(sessionId, mapping);
    return mapping;
  }

  async recoverStaleWorkers(now = new Date()): Promise<StaleWorkerRecoveryResult> {
    const staleWorkerIds = await this.registry.pruneStale(now);
    if (staleWorkerIds.length === 0) return { staleWorkerIds, affectedSessions: [] };

    const staleWorkers = new Set(staleWorkerIds);
    const affectedSessions: SessionWorkerMapping[] = [];
    for (const mapping of this.sessionWorkers.values()) {
      if (!staleWorkers.has(mapping.workerId)) continue;
      const affected = this.markSessionInterrupted(
        mapping,
        `Worker heartbeat timed out after ${env.WORKER_STALE_AFTER_MS}ms.`,
      );
      affectedSessions.push(affected);
      if (this.recoveryPolicy.enabled && this.recoveryPolicy.autoAllocate) {
        await this.recoverSessionOnReplacement(affected);
      }
    }

    return { staleWorkerIds, affectedSessions };
  }

  releaseSession(sessionId: string): boolean {
    this.sessionRecoveryInputs.delete(sessionId);
    return this.sessionWorkers.delete(sessionId);
  }

  async markWorkerDraining(workerId: string): Promise<WorkerRegistration | undefined> {
    const worker = await this.registry.markDraining(workerId);
    for (const [sessionId, mapping] of this.sessionWorkers.entries()) {
      if (mapping.workerId === workerId && !worker) this.sessionWorkers.delete(sessionId);
    }
    return worker;
  }

  getSessionMapping(sessionId: string): SessionWorkerMapping | undefined {
    return this.sessionWorkers.get(sessionId);
  }

  listSessionMappings(): SessionWorkerMapping[] {
    return Array.from(this.sessionWorkers.values()).sort((a, b) =>
      a.sessionId.localeCompare(b.sessionId),
    );
  }

  async listWorkers(): Promise<WorkerRegistration[]> {
    await this.recoverStaleWorkers();
    return this.registry.list();
  }

  private async findAvailableWorker(
    excludedWorkerIds = new Set<string>(),
  ): Promise<WorkerRegistration | undefined> {
    const workers = await this.registry.list();
    const assignedByWorker = new Map<string, number>();
    for (const mapping of this.sessionWorkers.values()) {
      if (!canProxyMapping(mapping)) continue;
      assignedByWorker.set(mapping.workerId, (assignedByWorker.get(mapping.workerId) ?? 0) + 1);
    }

    return workers.find((candidate) => {
      if (excludedWorkerIds.has(candidate.id)) return false;
      if (!candidate.endpoint) return false;
      if (candidate.state !== "ready") return false;
      if (!candidate.capacity.acceptingSessions) return false;
      const reserved = assignedByWorker.get(candidate.id) ?? 0;
      return candidate.capacity.availableSessions - reserved > 0;
    });
  }

  private markSessionInterrupted(
    mapping: SessionWorkerMapping,
    reason: string,
  ): SessionWorkerMapping {
    const now = new Date().toISOString();
    const recovery: SessionRecoveryStatus = {
      ...(mapping.recovery ?? { attempts: 0, canRecover: this.recoveryPolicy.enabled }),
      state: this.recoveryPolicy.enabled ? "recovering" : "interrupted",
      reason,
      interruptedAt: mapping.recovery?.interruptedAt ?? now,
      recoveryStartedAt: this.recoveryPolicy.enabled
        ? mapping.recovery?.recoveryStartedAt ?? now
        : mapping.recovery?.recoveryStartedAt,
      sourceWorkerId: mapping.recovery?.sourceWorkerId ?? mapping.workerId,
      canRecover: this.recoveryPolicy.enabled,
      restoredFrom: restoredFrom(this.sessionRecoveryInputs.get(mapping.sessionId)),
    };
    const next = { ...mapping, recovery };
    this.sessionWorkers.set(mapping.sessionId, next);
    this.recordRecoveryEvent(
      this.recoveryPolicy.enabled ? "session_recovering" : "session_interrupted",
      next,
      reason,
    );
    return next;
  }

  private async recoverSessionOnReplacement(mapping: SessionWorkerMapping): Promise<void> {
    const input = this.sessionRecoveryInputs.get(mapping.sessionId);
    const sourceWorkerId = mapping.recovery?.sourceWorkerId ?? mapping.workerId;
    const attempts = (mapping.recovery?.attempts ?? 0) + 1;
    if (attempts > this.recoveryPolicy.maxAttempts) {
      this.markRecoveryFailed(mapping, "Maximum session recovery attempts reached.");
      return;
    }

    const worker = await this.findAvailableWorker(new Set([sourceWorkerId]));
    if (!worker) {
      this.markRecoveryFailed(mapping, "No replacement worker currently has available capacity.");
      return;
    }

    const now = new Date().toISOString();
    const recovery: SessionRecoveryStatus = {
      ...(mapping.recovery ?? { canRecover: true }),
      state: "recovering",
      attempts,
      canRecover: true,
      recoveryStartedAt: mapping.recovery?.recoveryStartedAt ?? now,
      sourceWorkerId,
      replacementWorkerId: worker.id,
      restoredFrom: restoredFrom(input),
      reason: "Best-effort recovery is starting on a replacement worker.",
    };
    const recoveringMapping: SessionWorkerMapping = {
      ...mapping,
      workerId: worker.id,
      endpoint: trimTrailingSlash(worker.endpoint!),
      allocatedAt: now,
      recovery,
    };
    this.sessionWorkers.set(mapping.sessionId, recoveringMapping);
    this.recordRecoveryEvent("session_recovering", recoveringMapping, recovery.reason);

    try {
      const response = await fetch(`${recoveringMapping.endpoint}/v1/sessions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-steel-scheduler": "1",
          "x-steel-session-recovery": "1",
        },
        body: JSON.stringify({ ...(input ?? {}), sessionId: mapping.sessionId }),
      });
      if (!response.ok) {
        throw new Error(`Replacement worker returned ${response.status}`);
      }

      const recovered: SessionWorkerMapping = {
        ...recoveringMapping,
        recovery: {
          ...recovery,
          state: "recovered",
          reason:
            "Session was recreated on a replacement worker using available persisted inputs; this is not live Chrome process migration.",
          recoveredAt: new Date().toISOString(),
        },
      };
      this.sessionWorkers.set(mapping.sessionId, recovered);
      this.recordRecoveryEvent("session_recovered", recovered, recovered.recovery?.reason);
    } catch (error) {
      this.markRecoveryFailed(recoveringMapping, getErrors(error));
    }
  }

  private markRecoveryFailed(mapping: SessionWorkerMapping, reason: string): void {
    const failed: SessionWorkerMapping = {
      ...mapping,
      recovery: {
        ...(mapping.recovery ?? { attempts: 0, canRecover: this.recoveryPolicy.enabled }),
        state: "failed",
        reason,
        failedAt: new Date().toISOString(),
        canRecover: this.recoveryPolicy.enabled,
        lastError: reason,
      },
    };
    this.sessionWorkers.set(mapping.sessionId, failed);
    this.recordRecoveryEvent("session_recovery_failed", failed, reason);
  }

  private recordRecoveryEvent(
    type: SessionRecoveryEvent["type"],
    mapping: SessionWorkerMapping,
    reason?: string,
  ): void {
    const event: SessionRecoveryEvent = {
      type,
      sessionId: mapping.sessionId,
      workerId: mapping.recovery?.sourceWorkerId ?? mapping.workerId,
      replacementWorkerId: mapping.recovery?.replacementWorkerId,
      timestamp: new Date().toISOString(),
      reason,
      recovery: recoveryStatusForMapping(mapping),
    };
    this.recoveryEvents.push(event);
    if (this.recoveryEvents.length > 100) this.recoveryEvents.shift();
  }

  async routeHttpRequest(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<SchedulerProxyResult> {
    await this.recoverStaleWorkers();
    const method = request.method.toUpperCase();
    const rawUrl = request.raw.url ?? request.url;
    const url = new URL(rawUrl, "http://steel.local");

    if (!url.pathname.startsWith("/v1/")) return { proxied: false };
    if (
      url.pathname.startsWith("/v1/scheduler") ||
      url.pathname.startsWith("/v1/internal/worker")
    ) {
      return { proxied: false };
    }

    if (method === "POST" && url.pathname === "/v1/sessions") {
      return this.routeCreateSession(request, reply);
    }

    if (method === "GET" && url.pathname === "/v1/sessions") {
      return this.routeListSessions(request, reply);
    }

    const target = this.targetForSessionRequest(request, url.pathname);
    if (!target) return { proxied: false };
    if (!canProxyMapping(target.mapping)) {
      reply.code(503).send({
        success: false,
        message:
          "Session is unavailable while best-effort recovery is pending or failed; Chrome process migration is not supported.",
        sessionId: target.mapping.sessionId,
        recovery: recoveryStatusForMapping(target.mapping),
      });
      return { proxied: true, reason: target.mapping.recovery?.reason };
    }

    const response = await this.forwardHttp(request, target.mapping, rawUrl);
    await this.sendFetchResponse(reply, response, request, target.mapping, true);
    if (target.releaseAfterSuccess && response.ok) this.releaseSession(target.mapping.sessionId);
    return { proxied: true };
  }

  async routeCreateSession(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<SchedulerProxyResult> {
    const requestedSessionId =
      isObjectBody(request.body) && typeof request.body.sessionId === "string"
        ? request.body.sessionId
        : undefined;
    const allocation = await this.allocate({ sessionId: requestedSessionId });
    if (
      allocation.status !== "allocated" ||
      !allocation.worker ||
      !allocation.mapping ||
      !allocation.sessionId
    ) {
      reply.code(503).send({ success: false, message: allocation.reason ?? "No worker available" });
      return { proxied: true, reason: allocation.reason };
    }

    const originalBody = isObjectBody(request.body) ? request.body : {};
    const recoveryInput = { ...originalBody, sessionId: allocation.sessionId };
    request.body = recoveryInput;
    this.sessionRecoveryInputs.set(allocation.sessionId, recoveryInput);

    const response = await this.forwardHttp(
      request,
      allocation.mapping,
      request.raw.url ?? request.url,
    );
    if (!response.ok) {
      this.releaseSession(allocation.sessionId);
    }
    await this.sendFetchResponse(reply, response, request, allocation.mapping, true);
    return { proxied: true };
  }

  async routeListSessions(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<SchedulerProxyResult> {
    const sessions: unknown[] = [];
    const failures: Array<Record<string, unknown>> = [];
    for (const mapping of this.listSessionMappings()) {
      if (!canProxyMapping(mapping)) {
        sessions.push({
          id: mapping.sessionId,
          status: "failed",
          recovery: recoveryStatusForMapping(mapping),
        });
        continue;
      }
      try {
        const response = await fetch(
          `${mapping.endpoint}/v1/sessions/${encodeURIComponent(mapping.sessionId)}`,
          {
            method: "GET",
            headers: headersForFetch(request),
          },
        );
        if (!response.ok) {
          failures.push({
            sessionId: mapping.sessionId,
            workerId: mapping.workerId,
            statusCode: response.status,
          });
          continue;
        }
        const session = await response.json();
        sessions.push(attachRecoveryStatus(rewriteSessionUrls(session, request), mapping));
      } catch (error) {
        failures.push({
          sessionId: mapping.sessionId,
          workerId: mapping.workerId,
          error: getErrors(error),
        });
      }
    }
    reply.send({ sessions, workers: this.listSessionMappings(), failures });
    return { proxied: true };
  }

  targetForSessionRequest(request: FastifyRequest, pathname?: string): ProxyTarget | undefined {
    const sessionId = sessionIdFromRequest(request);
    const mapping = sessionId
      ? this.sessionWorkers.get(sessionId)
      : pathname?.startsWith("/v1/sessions/") && this.sessionWorkers.size === 1
      ? this.listSessionMappings()[0]
      : undefined;
    if (!mapping) return undefined;
    mapping.lastRoutedAt = new Date().toISOString();
    const resolvedPathname =
      pathname ?? new URL(request.raw.url ?? request.url, "http://steel.local").pathname;
    return {
      mapping,
      releaseAfterSuccess:
        request.method.toUpperCase() === "POST" && resolvedPathname.endsWith("/release"),
    };
  }

  private async forwardHttp(
    request: FastifyRequest,
    mapping: SessionWorkerMapping,
    rawUrl: string,
  ): Promise<Response> {
    const targetUrl = `${mapping.endpoint}${rawUrl}`;
    return fetch(targetUrl, {
      method: request.method,
      headers: headersForFetch(request),
      body: bodyForFetch(request),
      redirect: "manual",
    });
  }

  private async sendFetchResponse(
    reply: FastifyReply,
    response: Response,
    request: FastifyRequest,
    mapping: SessionWorkerMapping,
    rewriteUrls = false,
  ): Promise<void> {
    reply.code(response.status);
    response.headers.forEach((value, key) => {
      if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) reply.header(key, value);
    });
    reply.header("x-steel-worker-id", mapping.workerId);

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const json = await response.json();
      const rewritten = rewriteUrls ? rewriteSessionUrls(json, request) : json;
      reply.send(attachRecoveryStatus(rewritten, mapping));
      return;
    }

    if (contentType.startsWith("text/") || contentType.includes("html")) {
      const httpBase = schedulerBaseUrl(request, "http");
      const wsBase = schedulerBaseUrl(request, "ws");
      const workerHttpBase = mapping.endpoint;
      const workerWsBase = mapping.endpoint.replace(/^http/, "ws");
      const text = (await response.text())
        .split(workerHttpBase)
        .join(httpBase)
        .split(workerWsBase)
        .join(wsBase);
      reply.send(text);
      return;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    reply.send(buffer);
  }

  findMappingForWebSocket(
    url: string,
    headers: IncomingMessage["headers"] = {},
  ): SessionWorkerMapping | undefined {
    const parsed = new URL(url, "http://steel.local");
    const pathSessionId = sessionIdFromPath(parsed.pathname);
    const querySessionId = parsed.searchParams.get("sessionId") ?? undefined;
    const headerSessionId = headers["x-steel-session-id"];
    const sessionId =
      pathSessionId ??
      querySessionId ??
      (Array.isArray(headerSessionId) ? headerSessionId[0] : headerSessionId);

    if (sessionId) {
      const mapping = this.sessionWorkers.get(sessionId);
      return mapping && canProxyMapping(mapping) ? mapping : undefined;
    }
    const mappings = this.listSessionMappings().filter(canProxyMapping);
    return mappings.length === 1 ? mappings[0] : undefined;
  }

  async proxyWebSocket(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<boolean> {
    const mapping = this.findMappingForWebSocket(request.url ?? "", request.headers);
    if (!mapping) return false;

    const targetBase = new URL(mapping.endpoint);
    const transport = targetBase.protocol === "https:" ? https : http;
    const proxyRequest = transport.request({
      protocol: targetBase.protocol,
      hostname: targetBase.hostname,
      port: targetBase.port,
      method: "GET",
      path: request.url,
      headers: {
        ...request.headers,
        host: targetBase.host,
        "x-steel-scheduler": "1",
      },
    });

    await new Promise<void>((resolve, reject) => {
      proxyRequest.on("upgrade", (proxyResponse, proxySocket, proxyHead) => {
        const headers = Object.entries(proxyResponse.headers)
          .flatMap(([key, value]) =>
            Array.isArray(value) ? value.map((v) => [key, v]) : [[key, value]],
          )
          .filter((entry): entry is [string, string] => typeof entry[1] === "string")
          .map(([key, value]) => `${key}: ${value}`)
          .join("\r\n");
        socket.write(
          `HTTP/1.1 ${proxyResponse.statusCode ?? 101} ${
            proxyResponse.statusMessage ?? "Switching Protocols"
          }\r\n${headers}\r\n\r\n`,
        );
        if (proxyHead.length) socket.write(proxyHead);
        if (head.length) proxySocket.write(head);
        proxySocket.pipe(socket);
        socket.pipe(proxySocket);
        resolve();
      });
      proxyRequest.on("response", (proxyResponse) => {
        socket.write(
          `HTTP/1.1 ${proxyResponse.statusCode ?? 502} ${
            proxyResponse.statusMessage ?? "Bad Gateway"
          }\r\nConnection: close\r\n\r\n`,
        );
        proxyResponse.resume();
        socket.destroy();
        resolve();
      });
      proxyRequest.on("error", reject);
      proxyRequest.end();
    });

    return true;
  }
}
