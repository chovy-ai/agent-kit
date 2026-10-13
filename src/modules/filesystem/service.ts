import { Context } from "effect";
import type { Effect } from "effect";
import type { RunnerError } from "../go-bridge/index.js";
import type { EnvironmentRef } from "../environment/index.js";

export type FileType = "file" | "directory" | "symlink" | "other";
export interface PathRequest extends EnvironmentRef { path: string; }
export interface ReadFileRequest extends PathRequest { offset?: string; length?: number; }
export interface WriteFileRequest extends PathRequest { data: Uint8Array; }
export interface StatRequest extends PathRequest { followSymlinks?: boolean; }
export interface MkdirRequest extends PathRequest { recursive?: boolean; }
export interface DirectoryEntry { name: string; type: FileType; }
export interface FileInfo { type: FileType; size: string; modifiedAt: string; }
export interface FilesystemServiceApi {
  read(request: ReadFileRequest): Effect.Effect<{ data: Uint8Array }, RunnerError>;
  write(request: WriteFileRequest): Effect.Effect<{ bytesWritten: string }, RunnerError>;
  readDir(request: PathRequest): Effect.Effect<{ entries: DirectoryEntry[] }, RunnerError>;
  stat(request: StatRequest): Effect.Effect<FileInfo, RunnerError>;
  mkdir(request: MkdirRequest): Effect.Effect<{ created: true }, RunnerError>;
}

export class FilesystemService extends Context.Service<FilesystemService, FilesystemServiceApi>()("agent-kit/FilesystemService") {}
