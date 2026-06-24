import { mkdtemp, rm } from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tempDirs: string[] = [];

async function tempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "steel-artifacts-"));
  tempDirs.push(dir);
  return dir;
}

async function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("STEEL_TRACE_ARTIFACTS_ENABLED", "true");
  vi.stubEnv("STEEL_TRACE_ARTIFACTS_PREFIX", "telemetry/artifacts");
  vi.stubEnv("STEEL_TRACE_ARTIFACTS_MAX_BYTES", "104857600");
  vi.stubEnv("STEEL_TRACE_ARTIFACTS_MAX_EVENTS", "10000");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createService() {
  const root = await tempDir();
  const { FileService } = await import("../file.service.js");
  const { InMemoryStorage } = await import("../cdp/instrumentation/storage/in-memory-storage.js");
  const { BrowserEventType } = await import("../../types/enums.js");
  const { TraceArtifactService } = await import("./trace-artifact.service.js");

  const fileService = FileService.createForTesting({ localBasePath: root });
  const logStorage = new InMemoryStorage();
  await logStorage.initialize();

  await logStorage.write(
    {
      type: BrowserEventType.Navigation,
      timestamp: "2025-01-01T00:00:00.000Z",
      pageId: "page-1",
      navigation: { url: "https://example.com" },
    },
    { sessionId: "session-1" },
  );
  await logStorage.write(
    {
      type: BrowserEventType.Request,
      timestamp: "2025-01-01T00:00:01.000Z",
      pageId: "page-1",
      request: {
        method: "POST",
        url: "https://example.com/search?q=steel",
        resourceType: "xhr",
        postData: "secret body",
        headers: { accept: "application/json" },
      },
    },
    { sessionId: "session-1" },
  );
  await logStorage.write(
    {
      type: BrowserEventType.Response,
      timestamp: "2025-01-01T00:00:02.000Z",
      pageId: "page-1",
      response: {
        status: 200,
        url: "https://example.com/search?q=steel",
        mimeType: "application/json",
        headers: { "content-type": "application/json" },
        body: "secret response",
      },
    },
    { sessionId: "session-1" },
  );
  await logStorage.write(
    {
      type: BrowserEventType.Console,
      timestamp: "2025-01-01T00:00:03.000Z",
      console: { level: "log", text: "other session" },
    },
    { sessionId: "session-2" },
  );

  return { service: new TraceArtifactService({ fileService, logStorage }), fileService };
}

describe("TraceArtifactService", () => {
  it("reports export capabilities without heavy scanners/transcoders", async () => {
    vi.stubEnv("STEEL_TRACE_ARTIFACTS_ENABLED", "false");
    const { service } = await createService();

    expect(service.capabilities()).toMatchObject({
      enabled: false,
      storageProvider: "local",
      formats: { jsonl: true, har: true, zip: true },
      transcoders: { ffmpeg: false },
      scanners: { clamAv: false },
    });
  });

  it("exports session-scoped logger events as JSONL to file storage", async () => {
    const { service } = await createService();

    const artifact = await service.create({
      kind: "trace",
      format: "jsonl",
      sessionId: "session-1",
    });

    expect(artifact).toMatchObject({
      kind: "trace",
      format: "jsonl",
      status: "ready",
      sessionId: "session-1",
      eventCount: 3,
      contentType: "application/x-ndjson",
      storageProvider: "local",
    });
    expect(artifact.path).toMatch(/telemetry\/artifacts\/.+\/events\.jsonl$/);
    expect(artifact.files.map((file) => file.role)).toEqual(["metadata", "jsonl"]);

    const downloaded = await service.download(artifact.id);
    const jsonl = await readStream(downloaded.stream);
    expect(jsonl).toContain('"type":"Navigation"');
    expect(jsonl).toContain('"sessionId":"session-1"');
    expect(jsonl).not.toContain("secret body");
    expect(jsonl).not.toContain("secret response");

    await expect(service.get(artifact.id)).resolves.toMatchObject({
      id: artifact.id,
      status: "ready",
    });
    await expect(service.list()).resolves.toHaveLength(1);
  });

  it("exports HAR-ish network metadata", async () => {
    const { service } = await createService();

    const artifact = await service.create({ kind: "trace", format: "har", sessionId: "session-1" });
    const downloaded = await service.download(artifact.id);
    const har = JSON.parse(await readStream(downloaded.stream));

    expect(artifact).toMatchObject({ format: "har", contentType: "application/json" });
    expect(har.log.version).toBe("1.2");
    expect(har.log.pages).toHaveLength(1);
    expect(har.log.entries).toHaveLength(1);
    expect(har.log.entries[0]).toMatchObject({
      request: { method: "POST", url: "https://example.com/search?q=steel" },
      response: { status: 200 },
    });
    expect(JSON.stringify(har)).not.toContain("secret response");
  });

  it("creates replay ZIP archives without ffmpeg", async () => {
    const { service } = await createService();

    const artifact = await service.create({ kind: "replay", sessionId: "session-1" });

    expect(artifact).toMatchObject({
      kind: "replay",
      format: "zip",
      contentType: "application/zip",
    });
    expect(artifact.path).toMatch(/artifact\.zip$/);
    expect(artifact.files.map((file) => file.role)).toEqual(["metadata", "archive"]);
    const downloaded = await service.download(artifact.id);
    expect(downloaded.file.size).toBeGreaterThan(0);
  });

  it("rejects export while disabled", async () => {
    vi.stubEnv("STEEL_TRACE_ARTIFACTS_ENABLED", "false");
    const { service } = await createService();

    await expect(service.create({ kind: "trace" })).rejects.toThrow("disabled");
  });
});
