import { describe, expect, it } from "vitest";
import {
  isSafeExtensionName,
  validateArchiveEntries,
  validateArchiveEntryPath,
  validateExtensionManifest,
} from "./extensions.js";

describe("extension validation", () => {
  it("preserves local extension names while rejecting traversal", () => {
    expect(isSafeExtensionName("recorder")).toBe(true);
    expect(isSafeExtensionName("org-extension_1.2")).toBe(true);
    expect(isSafeExtensionName("../recorder")).toBe(false);
    expect(isSafeExtensionName("nested/recorder")).toBe(false);
  });

  it("validates extension manifests", () => {
    expect(
      validateExtensionManifest({ manifest_version: 3, name: "Test", version: "1.0.0" }),
    ).toMatchObject({ valid: true, errors: [] });

    expect(validateExtensionManifest({ manifest_version: 1 })).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        "manifest_version must be 2 or 3",
        "name is required",
        "version is required",
      ]),
    });
  });

  it("rejects zip entry path traversal", () => {
    expect(validateArchiveEntryPath("manifest.json")).toBeNull();
    expect(validateArchiveEntryPath("icons/icon.png")).toBeNull();
    expect(validateArchiveEntryPath("../manifest.json")).toContain("traverse");
    expect(validateArchiveEntryPath("icons/../../evil.js")).toContain("traverse");
    expect(validateArchiveEntryPath("C:/evil.js")).toContain("relative");
    expect(validateArchiveEntryPath("icons\\evil.js")).toContain("backslashes");
  });

  it("requires a root manifest for extension archives", () => {
    expect(validateArchiveEntries(["manifest.json", "content.js"])).toMatchObject({
      valid: true,
      errors: [],
    });
    expect(validateArchiveEntries(["extension/manifest.json"])).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        "Extension archive must contain manifest.json at the archive root",
      ]),
    });
  });
});

import fs from "fs";
import { tmpdir } from "os";
import path from "path";
import archiver from "archiver";
import { ExtensionRegistryService } from "../services/extensions/extension-registry.service.js";

async function createExtensionZip(manifest: Record<string, unknown>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  archive.append(JSON.stringify(manifest), { name: "manifest.json" });
  archive.append("console.log('ok');", { name: "content.js" });
  await archive.finalize();
  return Buffer.concat(chunks);
}

describe("extension upload materialization", () => {
  it("validates, extracts, and lists uploaded local extensions", async () => {
    const root = await fs.promises.mkdtemp(path.join(tmpdir(), "steel-ext-upload-"));
    try {
      const registry = new ExtensionRegistryService(root);
      const entry = await registry.uploadArchive({
        extensionId: "uploaded-test",
        archiveBuffer: await createExtensionZip({
          manifest_version: 3,
          name: "Uploaded",
          version: "1.0.0",
        }),
      });

      expect(entry).toMatchObject({
        id: "uploaded-test",
        status: "available",
        name: "Uploaded",
        version: "1.0.0",
      });
      await expect(
        fs.promises.readFile(path.join(root, "uploaded-test", "manifest.json"), "utf8"),
      ).resolves.toContain("Uploaded");
      expect(await registry.list()).toHaveLength(1);
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });
});
