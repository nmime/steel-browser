import fs from "fs";
import path, { dirname } from "path";
import { fileURLToPath } from "url";
import { listZipEntryNames } from "./zip.js";

export interface ExtensionManifestValidationResult {
  valid: boolean;
  errors: string[];
  manifest?: Record<string, unknown>;
}

export interface ExtensionArchiveValidationResult {
  valid: boolean;
  errors: string[];
  entries: string[];
}

export function getExtensionsRoot(): string {
  return path.join(dirname(fileURLToPath(import.meta.url)), "..", "..", "extensions");
}

export function isSafeExtensionName(name: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(name) && name !== "." && name !== ".." && !name.includes("..");
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function validateArchiveEntryPath(entryName: string): string | null {
  if (!entryName || entryName.includes("\0")) {
    return "Archive entry path must not be empty or contain NUL bytes";
  }
  if (entryName.includes("\\")) {
    return `Archive entry uses backslashes: ${entryName}`;
  }
  if (entryName.startsWith("/") || /^[a-zA-Z]:/.test(entryName)) {
    return `Archive entry must be relative: ${entryName}`;
  }

  const segments = entryName.split("/").filter(Boolean);
  if (!segments.length) {
    return `Archive entry must include a file name: ${entryName}`;
  }
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return `Archive entry must not traverse directories: ${entryName}`;
  }

  const normalized = path.posix.normalize(entryName);
  if (normalized !== entryName.replace(/\/+$/, "")) {
    return `Archive entry must be normalized: ${entryName}`;
  }

  return null;
}

export function validateArchiveEntries(entryNames: string[]): ExtensionArchiveValidationResult {
  const errors = entryNames
    .map((entryName) => validateArchiveEntryPath(entryName))
    .filter((error): error is string => !!error);

  if (!entryNames.some((entryName) => entryName === "manifest.json")) {
    errors.push("Extension archive must contain manifest.json at the archive root");
  }

  return {
    valid: errors.length === 0,
    errors,
    entries: entryNames,
  };
}

export function validateExtensionZipBuffer(zipBuffer: Buffer): ExtensionArchiveValidationResult {
  try {
    return validateArchiveEntries(listZipEntryNames(zipBuffer));
  } catch (error) {
    return {
      valid: false,
      errors: [error instanceof Error ? error.message : String(error)],
      entries: [],
    };
  }
}

export function validateExtensionManifest(manifest: unknown): ExtensionManifestValidationResult {
  const errors: string[] = [];

  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { valid: false, errors: ["Extension manifest must be a JSON object"] };
  }

  const value = manifest as Record<string, unknown>;

  if (value.manifest_version !== 2 && value.manifest_version !== 3) {
    errors.push("manifest_version must be 2 or 3");
  }
  if (typeof value.name !== "string" || value.name.trim().length === 0) {
    errors.push("name is required");
  }
  if (typeof value.version !== "string" || value.version.trim().length === 0) {
    errors.push("version is required");
  }

  return {
    valid: errors.length === 0,
    errors,
    manifest: value,
  };
}

export async function validateExtensionDirectory(
  extensionPath: string,
  root: string = getExtensionsRoot(),
): Promise<ExtensionManifestValidationResult> {
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(extensionPath);

  if (!isPathInside(resolvedRoot, resolvedPath)) {
    return {
      valid: false,
      errors: ["Extension path must remain inside the configured extensions directory"],
    };
  }

  const manifestPath = path.join(resolvedPath, "manifest.json");
  let raw: string;
  try {
    raw = await fs.promises.readFile(manifestPath, "utf8");
  } catch (error) {
    return {
      valid: false,
      errors: [
        `Unable to read extension manifest: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ],
    };
  }

  try {
    return validateExtensionManifest(JSON.parse(raw));
  } catch (error) {
    return {
      valid: false,
      errors: [
        `Extension manifest is not valid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ],
    };
  }
}

export async function getExtensionPaths(extensionNames: string[]): Promise<string[]> {
  const extensionsDir = process.env.STEEL_EXTENSIONS_DIR || getExtensionsRoot();

  try {
    await fs.promises.access(extensionsDir);
  } catch {
    console.warn("Extensions directory does not exist");
    return [];
  }

  const allExtensions = await fs.promises.readdir(extensionsDir);

  const candidatePaths = extensionNames
    .filter((name) => {
      if (!isSafeExtensionName(name)) {
        console.warn(`Ignoring unsafe extension name: ${name}`);
        return false;
      }
      return allExtensions.includes(name);
    })
    .map((dir) => path.join(extensionsDir, dir));

  const validationResults = await Promise.all(
    candidatePaths.map(async (fullPath) => {
      try {
        await fs.promises.access(fullPath);
        const validation = await validateExtensionDirectory(fullPath, extensionsDir);
        if (!validation.valid) {
          console.warn(
            `Extension directory ${fullPath} is invalid: ${validation.errors.join(", ")}`,
          );
        }
        return { path: fullPath, valid: validation.valid };
      } catch {
        console.warn(`Extension directory ${fullPath} does not exist`);
        return { path: fullPath, valid: false };
      }
    }),
  );

  return validationResults.filter((result) => result.valid).map((result) => result.path);
}
