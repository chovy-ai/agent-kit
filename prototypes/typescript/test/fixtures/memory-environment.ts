import { posix } from "node:path";
import { checkCancelled, RuntimeError } from "../../src/index.js";
import type {
  CommandRequest, CommandResult, EnvironmentFileSystem, ExecutionEnvironment, OperationOptions, ReadFileOptions,
} from "../../src/index.js";

/** Routing test double only: this does not connect to or simulate a real remote shell. */
export class MemoryTestEnvironment implements ExecutionEnvironment {
  readonly descriptor = Object.freeze({ id: "remote-test", kind: "test-only", cwd: "/remote-workspace" });
  readonly requests: CommandRequest[] = [];
  readonly fileCalls: Array<{ operation: string; path: string; options: OperationOptions }> = [];
  readonly data = new Map<string, Uint8Array>();
  private readonly directories = new Set(["/remote-workspace"]);
  readonly files: EnvironmentFileSystem = {
    readFile: async (path, options: ReadFileOptions) => {
      this.record("readFile", path, options);
      const data = this.data.get(this.path(path));
      if (!data) throw new RuntimeError("FILE_NOT_FOUND", `Remote test file not found: ${path}`);
      const start = options.offset ?? 0;
      return data.slice(start, options.length === undefined ? undefined : start + options.length);
    },
    writeFile: async (path, content, options) => {
      this.record("writeFile", path, options);
      if (!this.directories.has(posix.dirname(this.path(path)))) throw new RuntimeError("FILE_NOT_FOUND", "Missing parent");
      this.data.set(this.path(path), content.slice());
    },
    listDirectory: async (path, options) => {
      this.record("listDirectory", path, options);
      return [...this.data.keys()]
        .filter((entry) => posix.dirname(entry) === this.path(path))
        .map((entry) => ({ name: posix.basename(entry), type: "file" as const }));
    },
    stat: async (path, options) => {
      this.record("stat", path, options);
      const data = this.data.get(this.path(path));
      if (!data) throw new RuntimeError("FILE_NOT_FOUND", "Missing file");
      return { type: "file", size: data.length, modifiedAt: "2026-01-01T00:00:00.000Z" };
    },
    mkdir: async (path, options) => {
      this.record("mkdir", path, options);
      this.directories.add(this.path(path));
    },
  };

  async exec(request: CommandRequest): Promise<CommandResult> {
    checkCancelled(request.signal);
    this.requests.push(request);
    request.onOutput?.({ stream: "stdout", data: "from remote test adapter" });
    return {
      exitCode: 0, signal: null, stdout: "from remote test adapter", stderr: "", truncated: false, durationMs: 0,
    };
  }

  private path(path: string) { return posix.resolve(this.descriptor.cwd, path); }
  private record(operation: string, path: string, options: OperationOptions) {
    checkCancelled(options.signal);
    this.fileCalls.push({ operation, path, options });
  }
}
