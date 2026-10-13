export interface EnvironmentDescriptor {
  /** Stable host-configured identifier; never a credential or connection URL. */
  id: string;
  kind: string;
  cwd: string;
  description?: string;
}

export interface OperationOptions {
  signal?: AbortSignal;
}

export interface ReadFileOptions extends OperationOptions {
  /** Zero-based byte offset. */
  offset?: number;
  /** Maximum number of bytes to read; omitted means read until EOF. */
  length?: number;
}

export interface CommandOutput {
  stream: "stdout" | "stderr";
  data: string;
}

export interface CommandOptions extends OperationOptions {
  command: string;
  /** Relative to the environment's cwd, or an absolute path in that environment. */
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  /** Combined retained stdout/stderr byte limit. Streaming is independent of this limit. */
  maxOutputBytes?: number;
  onOutput?: (output: CommandOutput) => void;
}

/** SDK supplies defaults before calling the adapter. */
export interface CommandRequest extends CommandOptions {
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface CommandResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
}

export type FileType = "file" | "directory" | "symlink" | "other";

export interface FileInfo {
  type: FileType;
  size: number;
  modifiedAt: string;
}

export interface DirectoryEntry {
  name: string;
  type: FileType;
}

/** Every path is interpreted by this adapter, in its own environment. */
export interface EnvironmentFileSystem {
  readFile(path: string, options: ReadFileOptions): Promise<Uint8Array>;
  writeFile(path: string, content: Uint8Array, options: OperationOptions): Promise<void>;
  listDirectory(path: string, options: OperationOptions): Promise<DirectoryEntry[]>;
  stat(path: string, options: OperationOptions): Promise<FileInfo>;
  mkdir(path: string, options: OperationOptions & { recursive?: boolean }): Promise<void>;
}

/** Implement this contract to add SSH, HTTP sandboxes, containers or other environments. */
export interface ExecutionEnvironment {
  readonly descriptor: Readonly<EnvironmentDescriptor>;
  readonly files: EnvironmentFileSystem;
  exec(request: CommandRequest): Promise<CommandResult>;
}
