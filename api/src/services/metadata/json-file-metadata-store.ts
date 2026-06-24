import fs from "node:fs";
import path from "node:path";

export interface JsonFileMetadataStoreOptions<T extends object> {
  filePath?: string;
  defaults: () => T;
}

export class JsonFileMetadataStore<T extends object> {
  private state?: T;

  constructor(private readonly options: JsonFileMetadataStoreOptions<T>) {}

  public get persistent(): boolean {
    return Boolean(this.options.filePath);
  }

  public get filePath(): string | undefined {
    return this.options.filePath;
  }

  public loadSync(): T {
    if (this.state) return cloneJson(this.state);
    this.state = this.readFileSync() ?? this.options.defaults();
    return cloneJson(this.state);
  }

  public async load(): Promise<T> {
    if (this.state) return cloneJson(this.state);
    this.state = (await this.readFile()) ?? this.options.defaults();
    return cloneJson(this.state);
  }

  public saveSync(value: T): T {
    this.state = cloneJson(value);
    if (this.options.filePath) {
      atomicWriteJsonSync(this.options.filePath, this.state);
    }
    return cloneJson(this.state);
  }

  public async save(value: T): Promise<T> {
    this.state = cloneJson(value);
    if (this.options.filePath) {
      await atomicWriteJson(this.options.filePath, this.state);
    }
    return cloneJson(this.state);
  }

  public updateSync(mutator: (state: T) => T | void): T {
    const current = this.loadSync();
    const next = mutator(current) ?? current;
    return this.saveSync(next);
  }

  public async update(mutator: (state: T) => T | void | Promise<T | void>): Promise<T> {
    const current = await this.load();
    const next = (await mutator(current)) ?? current;
    return this.save(next);
  }

  private readFileSync(): T | undefined {
    if (!this.options.filePath || !fs.existsSync(this.options.filePath)) return undefined;
    return JSON.parse(fs.readFileSync(this.options.filePath, "utf8")) as T;
  }

  private async readFile(): Promise<T | undefined> {
    if (!this.options.filePath) return undefined;
    try {
      return JSON.parse(await fs.promises.readFile(this.options.filePath, "utf8")) as T;
    } catch (error: any) {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    }
  }
}

export function resolveMetadataFilePath(
  namespace: string,
  explicitPath?: string,
  basePath?: string,
): string | undefined {
  if (explicitPath) return explicitPath;
  if (!basePath) return undefined;
  return path.join(basePath, `${namespace}.json`);
}

export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function atomicWriteJsonSync(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
}

export async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.promises.rename(tmpPath, filePath);
}
