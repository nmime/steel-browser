import fs from "fs";
import path from "path";
import { inflateRawSync } from "zlib";

const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP_LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const MAX_ZIP_COMMENT_LENGTH = 0xffff;

export interface ParsedZipEntry {
  name: string;
  directory: boolean;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

function findEndOfCentralDirectory(zipBuffer: Buffer): number {
  const searchStart = Math.max(0, zipBuffer.length - MAX_ZIP_COMMENT_LENGTH - 22);
  for (let offset = zipBuffer.length - 22; offset >= searchStart; offset -= 1) {
    if (zipBuffer.readUInt32LE(offset) === ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      return offset;
    }
  }
  throw new Error("Invalid zip archive: end of central directory not found");
}

export function parseZipEntries(zipBuffer: Buffer): ParsedZipEntry[] {
  const eocdOffset = findEndOfCentralDirectory(zipBuffer);
  const entryCount = zipBuffer.readUInt16LE(eocdOffset + 10);
  const centralDirectoryOffset = zipBuffer.readUInt32LE(eocdOffset + 16);
  const entries: ParsedZipEntry[] = [];
  let offset = centralDirectoryOffset;

  for (let i = 0; i < entryCount; i += 1) {
    if (offset + 46 > zipBuffer.length) {
      throw new Error("Invalid zip archive: central directory is truncated");
    }
    if (zipBuffer.readUInt32LE(offset) !== ZIP_CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error("Invalid zip archive: central directory entry signature mismatch");
    }

    const compressionMethod = zipBuffer.readUInt16LE(offset + 10);
    const compressedSize = zipBuffer.readUInt32LE(offset + 20);
    const uncompressedSize = zipBuffer.readUInt32LE(offset + 24);
    const fileNameLength = zipBuffer.readUInt16LE(offset + 28);
    const extraFieldLength = zipBuffer.readUInt16LE(offset + 30);
    const commentLength = zipBuffer.readUInt16LE(offset + 32);
    const localHeaderOffset = zipBuffer.readUInt32LE(offset + 42);
    const fileNameStart = offset + 46;
    const fileNameEnd = fileNameStart + fileNameLength;

    if (fileNameEnd > zipBuffer.length) {
      throw new Error("Invalid zip archive: file name is truncated");
    }

    const rawName = zipBuffer.toString("utf8", fileNameStart, fileNameEnd);
    const name = rawName.replace(/\/+$/, "");
    if (name) {
      entries.push({
        name,
        directory: rawName.endsWith("/"),
        compressionMethod,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
      });
    }

    offset = fileNameEnd + extraFieldLength + commentLength;
  }

  return entries;
}

export function listZipEntryNames(zipBuffer: Buffer): string[] {
  return parseZipEntries(zipBuffer).map((entry) => entry.name);
}

function assertTargetPath(targetRoot: string, entryName: string): string {
  const resolvedRoot = path.resolve(targetRoot);
  const targetPath = path.resolve(resolvedRoot, ...entryName.split("/"));
  const relative = path.relative(resolvedRoot, targetPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Zip entry escapes target directory: ${entryName}`);
  }
  return targetPath;
}

function readEntryData(zipBuffer: Buffer, entry: ParsedZipEntry): Buffer {
  const offset = entry.localHeaderOffset;
  if (offset + 30 > zipBuffer.length) {
    throw new Error(`Invalid zip archive: local header is truncated for ${entry.name}`);
  }
  if (zipBuffer.readUInt32LE(offset) !== ZIP_LOCAL_FILE_HEADER_SIGNATURE) {
    throw new Error(`Invalid zip archive: local header signature mismatch for ${entry.name}`);
  }

  const fileNameLength = zipBuffer.readUInt16LE(offset + 26);
  const extraFieldLength = zipBuffer.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + fileNameLength + extraFieldLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > zipBuffer.length) {
    throw new Error(`Invalid zip archive: compressed data is truncated for ${entry.name}`);
  }

  const compressed = zipBuffer.subarray(dataStart, dataEnd);
  let data: Buffer;
  if (entry.compressionMethod === 0) {
    data = Buffer.from(compressed);
  } else if (entry.compressionMethod === 8) {
    data = inflateRawSync(compressed);
  } else {
    throw new Error(
      `Unsupported zip compression method ${entry.compressionMethod} for ${entry.name}`,
    );
  }

  if (data.length !== entry.uncompressedSize) {
    throw new Error(`Zip entry size mismatch for ${entry.name}`);
  }

  return data;
}

export async function extractZipBuffer(zipBuffer: Buffer, targetRoot: string): Promise<string[]> {
  const entries = parseZipEntries(zipBuffer);
  const written: string[] = [];
  await fs.promises.mkdir(targetRoot, { recursive: true });

  for (const entry of entries) {
    const targetPath = assertTargetPath(targetRoot, entry.name);
    if (entry.directory) {
      await fs.promises.mkdir(targetPath, { recursive: true });
      continue;
    }

    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.promises.writeFile(targetPath, readEntryData(zipBuffer, entry), { mode: 0o600 });
    written.push(entry.name);
  }

  return written;
}
