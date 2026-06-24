import { describe, expect, it } from "vitest";
import { ProfileStore } from "./profile.store.js";

describe("ProfileStore", () => {
  it("tracks redacted metadata-only profile versions", async () => {
    const store = new ProfileStore();
    const profile = await store.upsert({
      name: "work",
      metadata: { owner: "alice", token: "secret-token" },
      userDataDir: "/profiles/work",
      versionLabel: "initial",
    });

    const updated = await store.addVersion(profile.id, {
      metadata: { owner: "alice", password: "hidden" },
      versionLabel: "second",
    });

    expect(updated?.currentVersion).toBe(2);
    expect(updated?.metadata.password).toBe("[REDACTED]");
    expect(await store.versions(profile.id)).toHaveLength(2);
  });
});

import fs from "fs";
import { tmpdir } from "os";
import path from "path";
import { FileService } from "../file.service.js";
import { ProfileSnapshotService } from "./profile-snapshot.service.js";

describe("ProfileSnapshotService", () => {
  it("snapshots and restores userDataDir archives through file storage", async () => {
    const rootPath = await fs.promises.mkdtemp(path.join(tmpdir(), "steel-profile-files-"));
    const sourceDir = await fs.promises.mkdtemp(path.join(tmpdir(), "steel-profile-source-"));
    const targetDir = await fs.promises.mkdtemp(path.join(tmpdir(), "steel-profile-target-"));
    try {
      await fs.promises.mkdir(path.join(sourceDir, "Default"), { recursive: true });
      await fs.promises.writeFile(path.join(sourceDir, "Default", "Preferences"), '{"ok":true}');

      const store = new ProfileStore();
      const fileService = FileService.createForTesting({ localBasePath: rootPath });
      const snapshots = new ProfileSnapshotService(store, fileService);
      const profile = await store.upsert({ name: "restore-me" });

      const snapshotted = await snapshots.snapshot({
        profileId: profile.id,
        sourceUserDataDir: sourceDir,
        versionLabel: "snapshot",
      });

      expect(snapshotted.currentVersion).toBe(2);
      expect(snapshotted.versions.at(-1)?.metadata.snapshot).toMatchObject({
        sourceUserDataDir: sourceDir,
      });

      const restored = await snapshots.restore({
        profileId: profile.id,
        targetUserDataDir: targetDir,
      });

      expect(restored.restoredFiles).toContain("Default/Preferences");
      await expect(
        fs.promises.readFile(path.join(targetDir, "Default", "Preferences"), "utf8"),
      ).resolves.toBe('{"ok":true}');
    } finally {
      await Promise.all([
        fs.promises.rm(rootPath, { recursive: true, force: true }),
        fs.promises.rm(sourceDir, { recursive: true, force: true }),
        fs.promises.rm(targetDir, { recursive: true, force: true }),
      ]);
    }
  });
});
