import fs from "fs";
import { tmpdir } from "os";
import path from "path";
import { Readable } from "stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileService } from "../file.service.js";
import { LocalStorageProvider } from "./local-storage-provider.js";
import { InvalidStoragePathError, SignedUrlNotSupportedError } from "./storage-provider.js";

const streamFrom = (value: string) => Readable.from([value]);

describe("LocalStorageProvider", () => {
  let rootPath: string;

  beforeEach(async () => {
    rootPath = await fs.promises.mkdtemp(path.join(tmpdir(), "steel-storage-provider-"));
  });

  afterEach(async () => {
    await fs.promises.rm(rootPath, { recursive: true, force: true });
  });

  it("stores objects under the configured root and blocks traversal", async () => {
    const provider = new LocalStorageProvider(rootPath);

    await provider.saveObject({ key: "sessions/a/report.txt", stream: streamFrom("ok") });

    await expect(
      fs.promises.readFile(path.join(rootPath, "sessions/a/report.txt"), "utf8"),
    ).resolves.toBe("ok");
    await expect(
      provider.saveObject({ key: "../escape.txt", stream: streamFrom("no") }),
    ).rejects.toBeInstanceOf(InvalidStoragePathError);
    await expect(fs.promises.stat(path.join(rootPath, "../escape.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("FileService storage foundation", () => {
  let rootPath: string;
  let fileService: FileService;

  beforeEach(async () => {
    rootPath = await fs.promises.mkdtemp(path.join(tmpdir(), "steel-file-service-"));
    fileService = FileService.createForTesting({ localBasePath: rootPath, maxBytesPerSession: 5 });
  });

  afterEach(async () => {
    await fs.promises.rm(rootPath, { recursive: true, force: true });
  });

  it("isolates files by session while keeping API paths relative", async () => {
    await fileService.saveFile({
      sessionId: "session-a",
      filePath: "same.txt",
      stream: streamFrom("aaa"),
    });
    await fileService.saveFile({
      sessionId: "session-b",
      filePath: "same.txt",
      stream: streamFrom("bbb"),
    });

    await expect(
      fileService.downloadFile({ sessionId: "session-a", filePath: "same.txt" }),
    ).resolves.toMatchObject({
      size: 3,
    });
    await expect(
      fs.promises.readFile(path.join(rootPath, "sessions/session-a/same.txt"), "utf8"),
    ).resolves.toBe("aaa");
    await expect(
      fs.promises.readFile(path.join(rootPath, "sessions/session-b/same.txt"), "utf8"),
    ).resolves.toBe("bbb");

    const files = await fileService.listFiles({ sessionId: "session-a" });
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      path: "same.txt",
      sessionId: "session-a",
      storageProvider: "local",
    });
  });

  it("keeps global files isolated from session files", async () => {
    await fileService.saveFile({ filePath: "shared.txt", stream: streamFrom("g") });
    await fileService.saveFile({
      sessionId: "session-a",
      filePath: "shared.txt",
      stream: streamFrom("s"),
    });

    await expect(
      fs.promises.readFile(path.join(rootPath, "global/shared.txt"), "utf8"),
    ).resolves.toBe("g");
    await expect(
      fs.promises.readFile(path.join(rootPath, "sessions/session-a/shared.txt"), "utf8"),
    ).resolves.toBe("s");

    expect((await fileService.listFiles()).map((file) => file.path)).toEqual(["shared.txt"]);
    expect(
      (await fileService.listFiles({ sessionId: "session-a" })).map((file) => file.path),
    ).toEqual(["shared.txt"]);
  });

  it("cleans one session without deleting another", async () => {
    await fileService.saveFile({
      sessionId: "session-a",
      filePath: "a.txt",
      stream: streamFrom("a"),
    });
    await fileService.saveFile({
      sessionId: "session-b",
      filePath: "b.txt",
      stream: streamFrom("b"),
    });

    await fileService.cleanupFiles({ sessionId: "session-a" });

    await expect(
      fileService.getFile({ sessionId: "session-a", filePath: "a.txt" }),
    ).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(
      fileService.getFile({ sessionId: "session-b", filePath: "b.txt" }),
    ).resolves.toMatchObject({
      size: 1,
    });
  });

  it("enforces session quota and leaves failed writes unavailable", async () => {
    await fileService.saveFile({
      sessionId: "session-a",
      filePath: "a.txt",
      stream: streamFrom("abc"),
    });

    await expect(
      fileService.saveFile({
        sessionId: "session-a",
        filePath: "b.txt",
        stream: streamFrom("def"),
      }),
    ).rejects.toMatchObject({ statusCode: 413 });
    await expect(
      fileService.getFile({ sessionId: "session-a", filePath: "b.txt" }),
    ).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("returns a 501-style error for local signed URLs", async () => {
    await expect(
      fileService.createSignedUrl({ sessionId: "session-a", filePath: "a.txt", operation: "read" }),
    ).rejects.toBeInstanceOf(SignedUrlNotSupportedError);
  });
});
