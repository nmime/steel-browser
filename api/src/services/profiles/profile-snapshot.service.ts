import archiver from "archiver";
import fs from "fs";
import os from "os";
import path from "path";
import { Readable } from "stream";
import { v4 as uuidv4 } from "uuid";
import { FileService } from "../file.service.js";
import { extractZipBuffer } from "../../utils/zip.js";
import { ProfileRecord, ProfileStore } from "./profile.store.js";

export interface ProfileSnapshotMetadata {
  storagePath: string;
  size: number;
  sourceUserDataDir: string;
  createdAt: string;
}

export class ProfileSnapshotService {
  constructor(
    private readonly profileStore: ProfileStore,
    private readonly fileService: FileService,
  ) {}

  async snapshot(input: {
    profileId: string;
    sourceUserDataDir: string;
    versionLabel?: string;
    metadata?: Record<string, unknown>;
  }): Promise<ProfileRecord> {
    const profile = await this.profileStore.get(input.profileId);
    if (!profile) {
      throw Object.assign(new Error("Profile not found"), { statusCode: 404 });
    }

    const sourceUserDataDir = path.resolve(input.sourceUserDataDir);
    const stats = await fs.promises.stat(sourceUserDataDir);
    if (!stats.isDirectory()) {
      throw Object.assign(new Error("sourceUserDataDir must be a directory"), { statusCode: 400 });
    }

    const archivePath = await this.archiveDirectory(sourceUserDataDir);
    try {
      const storagePath = `profiles/${profile.id}/snapshots/${Date.now()}-${uuidv4()}.zip`;
      const saved = await this.fileService.saveFile({
        filePath: storagePath,
        stream: fs.createReadStream(archivePath),
        contentType: "application/zip",
      });
      return this.profileStore.addVersion(profile.id, {
        metadata: {
          ...profile.metadata,
          ...(input.metadata ?? {}),
          snapshot: {
            storagePath,
            size: saved.size,
            sourceUserDataDir,
            createdAt: new Date().toISOString(),
          } satisfies ProfileSnapshotMetadata,
        },
        versionLabel: input.versionLabel,
      }) as Promise<ProfileRecord>;
    } finally {
      await fs.promises.rm(archivePath, { force: true }).catch(() => undefined);
    }
  }

  async restore(input: {
    profileId: string;
    version?: number;
    targetUserDataDir: string;
  }): Promise<{ profile: ProfileRecord; storagePath: string; restoredFiles: string[] }> {
    const profile = await this.profileStore.get(input.profileId);
    if (!profile) {
      throw Object.assign(new Error("Profile not found"), { statusCode: 404 });
    }

    const version = input.version
      ? profile.versions.find((candidate) => candidate.version === input.version)
      : profile.versions.find((candidate) => candidate.version === profile.currentVersion);
    const snapshot = version?.metadata?.snapshot as Partial<ProfileSnapshotMetadata> | undefined;
    if (!version || typeof snapshot?.storagePath !== "string") {
      throw Object.assign(new Error("Profile version does not have a materialized snapshot"), {
        statusCode: 404,
      });
    }

    const downloaded = await this.fileService.downloadFile({ filePath: snapshot.storagePath });
    const archiveBuffer = await streamToBuffer(downloaded.stream);
    const targetUserDataDir = path.resolve(input.targetUserDataDir);
    await fs.promises.rm(targetUserDataDir, { recursive: true, force: true });
    await fs.promises.mkdir(targetUserDataDir, { recursive: true });
    const restoredFiles = await extractZipBuffer(archiveBuffer, targetUserDataDir);

    return { profile, storagePath: snapshot.storagePath, restoredFiles };
  }

  private async archiveDirectory(sourceUserDataDir: string): Promise<string> {
    const archivePath = path.join(os.tmpdir(), `profile-${uuidv4()}.zip`);
    await new Promise<void>((resolve, reject) => {
      const output = fs.createWriteStream(archivePath);
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
      archive.directory(sourceUserDataDir, false);
      archive.finalize().catch(settle);
    });
    return archivePath;
  }
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
