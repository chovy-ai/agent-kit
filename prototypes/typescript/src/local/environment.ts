import { lstat, mkdir, open, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { checkCancelled, normalizeError, RuntimeError } from "../errors.js";
import type {
  CommandRequest, EnvironmentDescriptor, EnvironmentFileSystem, ExecutionEnvironment, FileType, OperationOptions,
} from "../types.js";
import { runLocalCommand } from "./process.js";

export interface LocalEnvironmentOptions {
  id: string;
  cwd: string;
  description?: string;
  shell?: string;
}

function fileType(entry: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): FileType {
  if (entry.isSymbolicLink()) return "symlink";
  if (entry.isDirectory()) return "directory";
  if (entry.isFile()) return "file";
  return "other";
}

export class LocalEnvironment implements ExecutionEnvironment {
  readonly descriptor: Readonly<EnvironmentDescriptor>;
  readonly files: EnvironmentFileSystem;
  private readonly shell: string;

  constructor(options: LocalEnvironmentOptions) {
    if (process.platform === "win32") {
      throw new RuntimeError("INVALID_ARGUMENT", "LocalEnvironment currently requires macOS or Linux (POSIX shell)");
    }
    this.descriptor = Object.freeze({
      id: options.id, kind: "local", cwd: resolve(options.cwd),
      ...(options.description === undefined ? {} : { description: options.description }),
    });
    this.shell = options.shell ?? "/bin/sh";
    const pathInEnvironment = (path: string) => resolve(this.descriptor.cwd, path);
    this.files = {
      readFile: (path, operation) => this.io(operation, async () => {
        if (operation.offset === undefined && operation.length === undefined) {
          return readFile(pathInEnvironment(path), operation);
        }
        const handle = await open(pathInEnvironment(path), "r");
        try {
          const chunks: Buffer[] = [];
          let position = operation.offset ?? 0;
          let remaining = operation.length ?? Number.MAX_SAFE_INTEGER;
          while (remaining > 0) {
            checkCancelled(operation.signal);
            const buffer = Buffer.alloc(Math.min(remaining, 64 * 1024));
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
            if (bytesRead === 0) break;
            chunks.push(buffer.subarray(0, bytesRead));
            remaining -= bytesRead;
            position += bytesRead;
          }
          return Buffer.concat(chunks);
        } finally {
          await handle.close();
        }
      }),
      writeFile: (path, content, operation) => this.io(operation, () => writeFile(pathInEnvironment(path), content, operation)),
      listDirectory: (path, operation) => this.io(operation, async () => {
        const entries = await readdir(pathInEnvironment(path), { withFileTypes: true });
        return entries.map((entry) => ({ name: entry.name, type: fileType(entry) }))
          .sort((a, b) => a.name.localeCompare(b.name));
      }),
      stat: (path, operation) => this.io(operation, async () => {
        const stats = await lstat(pathInEnvironment(path));
        return { type: fileType(stats), size: stats.size, modifiedAt: stats.mtime.toISOString() };
      }),
      mkdir: (path, operation) => this.io(operation, async () => {
        await mkdir(pathInEnvironment(path), { recursive: operation.recursive ?? false });
      }),
    };
  }

  exec(request: CommandRequest) {
    return runLocalCommand(request, this.descriptor.cwd, this.shell);
  }

  private async io<T>(options: OperationOptions, action: () => Promise<T>): Promise<T> {
    checkCancelled(options.signal);
    try {
      const result = await action();
      checkCancelled(options.signal);
      return result;
    } catch (error) {
      checkCancelled(options.signal);
      throw normalizeError(error, "IO_ERROR");
    }
  }
}
