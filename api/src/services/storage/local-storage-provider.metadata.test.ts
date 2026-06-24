import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { LocalStorageProvider } from "./local-storage-provider.js";

describe("LocalStorageProvider metadata persistence", () => {
  it("restores content type and custom metadata from the file-backed metadata index", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "steel-file-provider-"));
    const root = path.join(dir, "objects");
    const metadataPath = path.join(dir, "metadata", "files.json");
    const provider = new LocalStorageProvider(root, metadataPath);

    await provider.saveObject({
      key: "sessions/session-a/report.txt",
      stream: Readable.from("hello"),
      contentType: "text/plain",
      metadata: { sessionId: "session-a" },
    });

    const reloaded = new LocalStorageProvider(root, metadataPath);
    await expect(reloaded.headObject("sessions/session-a/report.txt")).resolves.toMatchObject({
      contentType: "text/plain",
      metadata: { sessionId: "session-a" },
    });
    await expect(readFile(metadataPath, "utf8")).resolves.toContain("report.txt");
  });
});
