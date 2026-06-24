import archiver from "archiver";
import { createReadStream, createWriteStream } from "fs";
import fs from "fs/promises";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import path from "path";
import { Readable } from "stream";
import { env } from "../../env.js";
import { BrowserEventType } from "../../types/enums.js";
import { FileService } from "../file.service.js";
import { FileMetadata } from "../storage/index.js";
import { BrowserEventUnion } from "../cdp/instrumentation/types.js";
import { LogQuery, LogStorage } from "../cdp/instrumentation/storage/log-storage.interface.js";

export type TraceArtifactKind = "trace" | "replay";
export type TraceArtifactStatus = "pending" | "ready" | "failed";
export type TraceArtifactFormat = "jsonl" | "har" | "zip";

export interface TraceArtifactFile {
  path: string;
  role: "metadata" | "jsonl" | "har" | "archive";
  contentType: string;
  size: number;
  storageProvider: string;
  lastModified: string;
}

export interface TraceArtifact {
  id: string;
  kind: TraceArtifactKind;
  format: TraceArtifactFormat;
  status: TraceArtifactStatus;
  sessionId?: string;
  label?: string;
  metadata?: Record<string, unknown>;
  path: string;
  contentType: string;
  size: number;
  storageProvider: string;
  files: TraceArtifactFile[];
  query?: TraceArtifactQueryInput;
  eventCount: number;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export interface TraceArtifactCapabilities {
  enabled: boolean;
  storageProvider: "local";
  storagePrefix: string;
  maxBytes: number;
  maxEvents: number;
  formats: Record<TraceArtifactFormat, true>;
  transcoders: {
    ffmpeg: false;
  };
  scanners: {
    clamAv: false;
  };
}

export interface TraceArtifactQueryInput {
  startTime?: string;
  endTime?: string;
  eventTypes?: string[];
  pageId?: string;
  targetType?: string;
  limit?: number;
  offset?: number;
}

export interface CreateTraceArtifactInput {
  kind: TraceArtifactKind;
  format?: TraceArtifactFormat;
  sessionId?: string;
  label?: string;
  metadata?: Record<string, unknown>;
  query?: TraceArtifactQueryInput;
}

export interface TraceArtifactServiceConfig {
  fileService: FileService;
  logStorage?: LogStorage | null;
  logger?: { error(obj: object, msg?: string): void };
  storagePrefix?: string;
}

type ExportableEvent = BrowserEventUnion & Record<string, unknown>;

const CONTENT_TYPES: Record<TraceArtifactFormat, string> = {
  jsonl: "application/x-ndjson",
  har: "application/json",
  zip: "application/zip",
};

export class TraceArtifactService {
  private readonly fileService: FileService;
  private readonly logStorage: LogStorage | null;
  private readonly logger?: TraceArtifactServiceConfig["logger"];
  private readonly storagePrefix: string;

  constructor(config: TraceArtifactServiceConfig) {
    this.fileService = config.fileService;
    this.logStorage = config.logStorage ?? null;
    this.logger = config.logger;
    this.storagePrefix = this.normalizePrefix(
      config.storagePrefix ?? env.STEEL_TRACE_ARTIFACTS_PREFIX,
    );
  }

  public capabilities(): TraceArtifactCapabilities {
    return {
      enabled: env.STEEL_TRACE_ARTIFACTS_ENABLED,
      storageProvider: "local",
      storagePrefix: this.storagePrefix,
      maxBytes: env.STEEL_TRACE_ARTIFACTS_MAX_BYTES,
      maxEvents: env.STEEL_TRACE_ARTIFACTS_MAX_EVENTS,
      formats: { jsonl: true, har: true, zip: true },
      transcoders: {
        ffmpeg: false,
      },
      scanners: {
        clamAv: false,
      },
    };
  }

  public async list(): Promise<TraceArtifact[]> {
    const metadataFiles = (await this.fileService.listFiles())
      .filter((file) => this.isArtifactMetadataPath(file.path))
      .sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());

    const artifacts = await Promise.all(metadataFiles.map((file) => this.readMetadata(file.path)));
    return artifacts.filter((artifact): artifact is TraceArtifact => !!artifact);
  }

  public async get(id: string): Promise<TraceArtifact | undefined> {
    if (!this.isSafeId(id)) return undefined;
    return this.readMetadata(this.metadataPath(id));
  }

  public async download(
    id: string,
  ): Promise<{ artifact: TraceArtifact; file: FileMetadata; stream: Readable }> {
    const artifact = await this.get(id);
    if (!artifact) {
      throw new Error("Artifact not found");
    }

    const object = await this.fileService.downloadFile({ filePath: artifact.path });
    return {
      artifact,
      file: {
        key: artifact.path,
        path: artifact.path,
        size: object.size,
        lastModified: object.lastModified,
        storageProvider: artifact.storageProvider,
      },
      stream: object.stream,
    };
  }

  public async create(input: CreateTraceArtifactInput): Promise<TraceArtifact> {
    if (!env.STEEL_TRACE_ARTIFACTS_ENABLED) {
      throw new Error("Trace/replay artifact service is disabled");
    }
    if (!this.logStorage) {
      throw new Error("Browser log storage is not available for artifact export");
    }

    const id = randomUUID();
    const format = input.format ?? (input.kind === "replay" ? "zip" : "jsonl");
    const now = new Date().toISOString();
    const base: Omit<TraceArtifact, "path" | "contentType" | "size" | "storageProvider" | "files"> =
      {
        id,
        kind: input.kind,
        format,
        status: "pending",
        sessionId: input.sessionId,
        label: input.label,
        metadata: input.metadata,
        query: input.query,
        eventCount: 0,
        createdAt: now,
        updatedAt: now,
      };

    try {
      await this.logStorage.flush();
      const events = await this.collectEvents(input);
      const exported = await this.exportEvents(id, format, events, base);
      const ready: TraceArtifact = {
        ...base,
        status: "ready",
        path: exported.primary.path,
        contentType: exported.primary.contentType,
        size: exported.primary.size,
        storageProvider: exported.primary.storageProvider,
        files: exported.files,
        eventCount: events.length,
        updatedAt: new Date().toISOString(),
      };

      const metadataFile = await this.saveMetadata(ready);
      const complete = { ...ready, files: [metadataFile, ...ready.files] };
      await this.saveMetadata(complete);
      return complete;
    } catch (error) {
      const failed: TraceArtifact = {
        ...base,
        status: "failed",
        path: this.metadataPath(id),
        contentType: "application/json",
        size: 0,
        storageProvider: "local",
        files: [],
        updatedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      };
      await this.saveMetadata(failed).catch((metadataError) => {
        this.logger?.error(
          { error: metadataError },
          "Failed to persist failed trace artifact metadata",
        );
      });
      throw error;
    }
  }

  private async collectEvents(input: CreateTraceArtifactInput): Promise<ExportableEvent[]> {
    const query = this.toLogQuery(input.query);
    const limit = Math.min(
      input.query?.limit ?? env.STEEL_TRACE_ARTIFACTS_MAX_EVENTS,
      env.STEEL_TRACE_ARTIFACTS_MAX_EVENTS,
    );
    const result = await this.logStorage!.query({ ...query, limit });
    let events = result.events as ExportableEvent[];

    if (input.sessionId) {
      events = events.filter((event) => event.sessionId === input.sessionId);
    }

    return events.map((event) => this.sanitizeEvent(event));
  }

  private async exportEvents(
    id: string,
    format: TraceArtifactFormat,
    events: ExportableEvent[],
    base: Pick<
      TraceArtifact,
      "id" | "kind" | "format" | "sessionId" | "label" | "metadata" | "query" | "createdAt"
    >,
  ): Promise<{ primary: TraceArtifactFile; files: TraceArtifactFile[] }> {
    if (format === "jsonl") {
      const body = this.toJsonl(events);
      const primary = await this.savePayload(
        id,
        "events.jsonl",
        body,
        CONTENT_TYPES.jsonl,
        "jsonl",
      );
      return { primary, files: [primary] };
    }

    if (format === "har") {
      const body = JSON.stringify(this.toHar(events), null, 2);
      const primary = await this.savePayload(id, "trace.har.json", body, CONTENT_TYPES.har, "har");
      return { primary, files: [primary] };
    }

    const jsonl = this.toJsonl(events);
    const har = JSON.stringify(this.toHar(events), null, 2);
    const manifest = JSON.stringify(
      {
        ...base,
        status: "ready",
        eventCount: events.length,
        generatedAt: new Date().toISOString(),
        files: ["events.jsonl", "trace.har.json"],
        notes: [
          "Replay archive contains metadata/event exports only; video capture and ffmpeg transcoding are not included.",
        ],
      },
      null,
      2,
    );
    const zipPath = await this.buildZip(id, {
      "artifact.json": manifest,
      "events.jsonl": jsonl,
      "trace.har.json": har,
    });
    const stats = await fs.stat(zipPath);
    this.assertWithinMaxBytes(stats.size);
    const saved = await this.fileService.saveFile({
      filePath: this.payloadPath(id, "artifact.zip"),
      stream: createReadStream(zipPath),
      contentType: CONTENT_TYPES.zip,
    });
    await fs.rm(path.dirname(zipPath), { recursive: true, force: true });
    const primary = this.toArtifactFile(saved, "archive", CONTENT_TYPES.zip);
    return { primary, files: [primary] };
  }

  private async savePayload(
    id: string,
    fileName: string,
    body: string,
    contentType: string,
    role: TraceArtifactFile["role"],
  ): Promise<TraceArtifactFile> {
    this.assertWithinMaxBytes(Buffer.byteLength(body));
    const saved = await this.fileService.saveFile({
      filePath: this.payloadPath(id, fileName),
      stream: Readable.from([body]),
      contentType,
    });
    return this.toArtifactFile(saved, role, contentType);
  }

  private async saveMetadata(artifact: TraceArtifact): Promise<TraceArtifactFile> {
    const saved = await this.fileService.saveFile({
      filePath: this.metadataPath(artifact.id),
      stream: Readable.from([JSON.stringify(artifact, null, 2)]),
      contentType: "application/json",
    });
    return this.toArtifactFile(saved, "metadata", "application/json");
  }

  private async readMetadata(filePath: string): Promise<TraceArtifact | undefined> {
    try {
      const { stream } = await this.fileService.downloadFile({ filePath });
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as TraceArtifact;
    } catch {
      return undefined;
    }
  }

  private toJsonl(events: ExportableEvent[]): string {
    return events.map((event) => JSON.stringify(event)).join("\n") + (events.length ? "\n" : "");
  }

  private toHar(events: ExportableEvent[]) {
    const pages = new Map<
      string,
      { startedDateTime: string; id: string; title: string; pageTimings: Record<string, number> }
    >();
    const responsesByUrl = new Map<string, ExportableEvent[]>();

    for (const event of events) {
      if (event.type === BrowserEventType.Navigation && event.pageId) {
        pages.set(String(event.pageId), {
          startedDateTime: event.timestamp,
          id: String(event.pageId),
          title: String((event.navigation as any)?.url ?? event.pageId),
          pageTimings: {},
        });
      }
      if (event.type === BrowserEventType.Response) {
        const url = String((event.response as any)?.url ?? "");
        if (!responsesByUrl.has(url)) responsesByUrl.set(url, []);
        responsesByUrl.get(url)!.push(event);
      }
    }

    const entries = events
      .filter((event) => event.type === BrowserEventType.Request)
      .map((event) => {
        const request = event.request as any;
        const response = responsesByUrl.get(String(request.url))?.shift();
        const responseData = (response?.response ?? {}) as any;
        return {
          pageref: event.pageId,
          startedDateTime: event.timestamp,
          time: -1,
          request: {
            method: request.method,
            url: request.url,
            httpVersion: "HTTP/1.1",
            headers: this.toHarHeaders(request.headers),
            queryString: this.toHarQueryString(request.url),
            cookies: [],
            headersSize: -1,
            bodySize: -1,
            _resourceType: request.resourceType,
          },
          response: {
            status: responseData.status ?? 0,
            statusText: "",
            httpVersion: "HTTP/1.1",
            headers: this.toHarHeaders(responseData.headers),
            cookies: [],
            content: {
              size: -1,
              mimeType: responseData.mimeType ?? "",
            },
            redirectURL: "",
            headersSize: -1,
            bodySize: -1,
            _url: responseData.url,
          },
          cache: {},
          timings: { send: -1, wait: -1, receive: -1 },
          _steel: {
            targetType: event.targetType,
            matchedResponseTimestamp: response?.timestamp,
          },
        };
      });

    return {
      log: {
        version: "1.2",
        creator: { name: "steel-browser", version: "0.5.2" },
        pages: Array.from(pages.values()),
        entries,
        _steel: {
          exportedAt: new Date().toISOString(),
          eventCount: events.length,
          nonNetworkEvents: events.filter(
            (event) =>
              event.type !== BrowserEventType.Request && event.type !== BrowserEventType.Response,
          ),
          bodyPolicy:
            "request postData, response body, and ResponseBody payloads are omitted from trace artifact exports",
        },
      },
    };
  }

  private sanitizeEvent(event: ExportableEvent): ExportableEvent {
    const sanitized = JSON.parse(JSON.stringify(event)) as ExportableEvent;
    if ((sanitized.request as any)?.postData) {
      (sanitized.request as any).postData = `[omitted:${
        String((event.request as any).postData).length
      }]`;
    }
    if ((sanitized.response as any)?.body) {
      (sanitized.response as any).body = `[omitted:${String((event.response as any).body).length}]`;
    }
    if ((sanitized.responseBody as any)?.body) {
      (sanitized.responseBody as any).body = `[omitted:${
        String((event.responseBody as any).body).length
      }]`;
    }
    return sanitized;
  }

  private toHarHeaders(headers?: Record<string, string>) {
    if (!headers) return [];
    return Object.entries(headers).map(([name, value]) => ({ name, value: String(value) }));
  }

  private toHarQueryString(url?: string) {
    if (!url) return [];
    try {
      return Array.from(new URL(url).searchParams.entries()).map(([name, value]) => ({
        name,
        value,
      }));
    } catch {
      return [];
    }
  }

  private toLogQuery(query?: TraceArtifactQueryInput): LogQuery {
    return {
      startTime: query?.startTime ? new Date(query.startTime) : undefined,
      endTime: query?.endTime ? new Date(query.endTime) : undefined,
      eventTypes: query?.eventTypes,
      pageId: query?.pageId,
      targetType: query?.targetType,
      limit: query?.limit,
      offset: query?.offset,
    };
  }

  private async buildZip(id: string, files: Record<string, string>): Promise<string> {
    const dir = await fs.mkdtemp(path.join(tmpdir(), "steel-trace-artifact-"));
    const zipPath = path.join(dir, `${id}.zip`);

    await new Promise<void>((resolve, reject) => {
      const output = createWriteStream(zipPath);
      const archive = archiver("zip", { zlib: { level: 9 } });
      let settled = false;
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        error ? reject(error) : resolve();
      };
      output.on("close", () => settle());
      output.on("error", settle);
      archive.on("error", settle);
      archive.pipe(output);
      for (const [name, body] of Object.entries(files)) {
        archive.append(body, { name });
      }
      archive.finalize().catch(settle);
    });

    return zipPath;
  }

  private toArtifactFile(
    file: FileMetadata,
    role: TraceArtifactFile["role"],
    contentType: string,
  ): TraceArtifactFile {
    return {
      path: file.path,
      role,
      contentType,
      size: file.size,
      storageProvider: file.storageProvider,
      lastModified: file.lastModified.toISOString(),
    };
  }

  private assertWithinMaxBytes(size: number) {
    if (size > env.STEEL_TRACE_ARTIFACTS_MAX_BYTES) {
      throw new Error(
        `Trace artifact exceeds max size (${size} > ${env.STEEL_TRACE_ARTIFACTS_MAX_BYTES})`,
      );
    }
  }

  private payloadPath(id: string, fileName: string): string {
    return `${this.storagePrefix}/${id}/${fileName}`;
  }

  private metadataPath(id: string): string {
    return `${this.storagePrefix}/${id}/metadata.json`;
  }

  private isArtifactMetadataPath(filePath: string): boolean {
    return filePath.startsWith(`${this.storagePrefix}/`) && filePath.endsWith("/metadata.json");
  }

  private normalizePrefix(prefix: string): string {
    const normalized = path.posix.normalize(prefix.replace(/\\/g, "/")).replace(/^\/+|\/+$/g, "");
    if (!normalized || normalized === "." || normalized.startsWith("..")) {
      return "telemetry/artifacts";
    }
    return normalized;
  }

  private isSafeId(id: string): boolean {
    return /^[a-zA-Z0-9._-]+$/.test(id) && !id.includes("..");
  }
}
