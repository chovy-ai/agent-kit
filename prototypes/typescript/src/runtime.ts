import { checkCancelled, normalizeError, RuntimeError } from "./errors.js";
import type {
  CommandOptions, CommandResult, DirectoryEntry, EnvironmentDescriptor,
  ExecutionEnvironment, FileInfo, OperationOptions, ReadFileOptions,
} from "./types.js";

export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

function requireText(value: string, name: string): void {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new RuntimeError("INVALID_ARGUMENT", `${name} must be a non-empty string without NUL characters`);
  }
}

function positiveInteger(value: number, name: string, max = Number.MAX_SAFE_INTEGER): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new RuntimeError("INVALID_ARGUMENT", `${name} must be a positive integer at most ${max}`);
  }
}

export class Runtime {
  private readonly environments = new Map<string, ExecutionEnvironment>();

  constructor(environments: Iterable<ExecutionEnvironment> = []) {
    for (const environment of environments) this.register(environment);
  }

  register(environment: ExecutionEnvironment): this {
    const { id, kind, cwd } = environment.descriptor;
    requireText(id, "environmentId");
    requireText(kind, "kind");
    requireText(cwd, "cwd");
    if (this.environments.has(id)) {
      throw new RuntimeError("DUPLICATE_ENVIRONMENT", `Environment already registered: ${id}`);
    }
    this.environments.set(id, environment);
    return this;
  }

  listEnvironments(): EnvironmentDescriptor[] {
    return [...this.environments.values()].map((environment) => ({ ...environment.descriptor }));
  }

  async exec(environmentId: string, options: CommandOptions): Promise<CommandResult> {
    const environment = this.resolve(environmentId);
    requireText(options.command, "command");
    if (options.cwd !== undefined) requireText(options.cwd, "cwd");
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    positiveInteger(timeoutMs, "timeoutMs", 2_147_483_647);
    positiveInteger(maxOutputBytes, "maxOutputBytes");
    for (const [name, value] of Object.entries(options.env ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof value !== "string" || value.includes("\0")) {
        throw new RuntimeError("INVALID_ARGUMENT", `Invalid environment variable: ${name}`);
      }
    }
    return this.run(options, () => environment.exec({ ...options, timeoutMs, maxOutputBytes }));
  }

  async readFile(environmentId: string, path: string, options: ReadFileOptions = {}): Promise<Uint8Array> {
    const environment = this.resolvePath(environmentId, path);
    if (options.offset !== undefined && (!Number.isSafeInteger(options.offset) || options.offset < 0)) {
      throw new RuntimeError("INVALID_ARGUMENT", "offset must be a non-negative safe integer");
    }
    if (options.length !== undefined) positiveInteger(options.length, "length");
    return this.run(options, () => environment.files.readFile(path, options));
  }

  async writeFile(
    environmentId: string, path: string, content: string | Uint8Array, options: OperationOptions = {},
  ): Promise<void> {
    const environment = this.resolvePath(environmentId, path);
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    return this.run(options, () => environment.files.writeFile(path, bytes, options));
  }

  async listDirectory(environmentId: string, path = ".", options: OperationOptions = {}): Promise<DirectoryEntry[]> {
    const environment = this.resolvePath(environmentId, path);
    return this.run(options, () => environment.files.listDirectory(path, options));
  }

  async stat(environmentId: string, path: string, options: OperationOptions = {}): Promise<FileInfo> {
    const environment = this.resolvePath(environmentId, path);
    return this.run(options, () => environment.files.stat(path, options));
  }

  async mkdir(
    environmentId: string, path: string, options: OperationOptions & { recursive?: boolean } = {},
  ): Promise<void> {
    const environment = this.resolvePath(environmentId, path);
    return this.run(options, () => environment.files.mkdir(path, options));
  }

  private resolve(environmentId: string): ExecutionEnvironment {
    requireText(environmentId, "environmentId");
    const environment = this.environments.get(environmentId);
    if (!environment) throw new RuntimeError("UNKNOWN_ENVIRONMENT", `Unknown environment: ${environmentId}`);
    return environment;
  }

  private resolvePath(environmentId: string, path: string): ExecutionEnvironment {
    requireText(path, "path");
    return this.resolve(environmentId);
  }

  private async run<T>(options: OperationOptions, action: () => Promise<T>): Promise<T> {
    checkCancelled(options.signal);
    try {
      const result = await action();
      checkCancelled(options.signal);
      return result;
    } catch (error) {
      checkCancelled(options.signal);
      throw normalizeError(error, "ADAPTER_ERROR");
    }
  }
}
