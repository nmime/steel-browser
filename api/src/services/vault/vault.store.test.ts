import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { VaultStore } from "./vault.store.js";

describe("VaultStore", () => {
  it("persists encrypted records while returning only redacted metadata", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "steel-vault-test-"));
    const filePath = path.join(dir, "vault.json");
    const store = new VaultStore({
      filePath,
      masterKey: Buffer.alloc(32, 3).toString("base64"),
    });

    const metadata = await store.put({
      type: "credential",
      name: "example",
      metadata: { username: "alice", password: "metadata-secret" },
      secret: { password: "hunter2" },
    });

    expect(metadata.secret).toBe("[REDACTED]");
    expect(metadata.metadata).toEqual({ username: "alice", password: "[REDACTED]" });
    expect(JSON.stringify(metadata)).not.toContain("hunter2");

    const file = await readFile(filePath, "utf8");
    expect(file).not.toContain("hunter2");
    expect(file).not.toContain("metadata-secret");
    expect(await store.list()).toHaveLength(1);
  });
});
