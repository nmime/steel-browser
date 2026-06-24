import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { JsonFileMetadataStore, resolveMetadataFilePath } from "./json-file-metadata-store.js";

describe("JsonFileMetadataStore", () => {
  it("persists JSON metadata atomically and reloads it", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "steel-metadata-store-"));
    const filePath = path.join(dir, "sessions.json");
    const store = new JsonFileMetadataStore<{ version: 1; records: Record<string, unknown> }>({
      filePath,
      defaults: () => ({ version: 1, records: {} }),
    });

    await store.update((state) => {
      state.records.sessionA = { status: "released" };
    });

    const reloaded = new JsonFileMetadataStore<{ version: 1; records: Record<string, unknown> }>({
      filePath,
      defaults: () => ({ version: 1, records: {} }),
    });

    await expect(reloaded.load()).resolves.toEqual({
      version: 1,
      records: { sessionA: { status: "released" } },
    });
    await expect(readFile(filePath, "utf8")).resolves.toContain('"sessionA"');
  });

  it("falls back to memory when no file path is configured", async () => {
    const store = new JsonFileMetadataStore<{ version: 1; records: string[] }>({
      defaults: () => ({ version: 1, records: [] }),
    });

    await store.update((state) => {
      state.records.push("auth");
    });

    await expect(store.load()).resolves.toEqual({ version: 1, records: ["auth"] });
  });

  it("resolves domain files under the shared metadata directory", () => {
    expect(resolveMetadataFilePath("auth", undefined, "/var/lib/steel/metadata")).toBe(
      "/var/lib/steel/metadata/auth.json",
    );
    expect(resolveMetadataFilePath("auth", "/explicit/auth.json", "/ignored")).toBe(
      "/explicit/auth.json",
    );
  });
});
