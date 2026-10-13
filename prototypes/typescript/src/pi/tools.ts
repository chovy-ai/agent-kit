import type { AgentToolResult, ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { TSchema } from "typebox";
import { normalizeError, RuntimeError } from "../errors.js";
import type { Runtime } from "../runtime.js";

export interface RuntimeToolDetails {
  operation: string;
  environmentId?: string;
  status: "success" | "error" | "running";
  result?: unknown;
  code?: string;
}

export interface PiToolsOptions {
  /** Host-side retained output cap for commands, default 64 KiB. */
  maxCommandOutputBytes?: number;
  /** Host-side UTF-8 file preview cap, default 64 KiB. */
  maxReadBytes?: number;
  /** Directory preview entry cap, default 200. */
  maxDirectoryEntries?: number;
}

function tool<T extends TSchema>(definition: ToolDefinition<T, RuntimeToolDetails>) {
  return defineTool(definition);
}

function success(operation: string, environmentId: string | undefined, result: unknown): AgentToolResult<RuntimeToolDetails> {
  return {
    content: [{ type: "text", text: JSON.stringify({ environmentId, result }) }],
    details: { operation, status: "success", result, ...(environmentId === undefined ? {} : { environmentId }) },
  };
}

async function report(
  operation: string, environmentId: string | undefined,
  action: () => Promise<AgentToolResult<RuntimeToolDetails>>,
): Promise<AgentToolResult<RuntimeToolDetails>> {
  try {
    return await action();
  } catch (error) {
    const normalized = normalizeError(error, "ADAPTER_ERROR");
    return {
      content: [{ type: "text", text: JSON.stringify({ environmentId, code: normalized.code, error: normalized.message }) }],
      details: {
        operation, status: "error", code: normalized.code,
        ...(environmentId === undefined ? {} : { environmentId }),
      },
      isError: true,
    };
  }
}

function limit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > 16 * 1024 * 1024) {
    throw new RuntimeError("INVALID_ARGUMENT", `${name} must be a positive integer at most 16777216`);
  }
  return resolved;
}

export function createRuntimeTools(runtime: Runtime, options: PiToolsOptions = {}): ToolDefinition[] {
  const outputLimit = limit(options.maxCommandOutputBytes, 64 * 1024, "maxCommandOutputBytes");
  const readLimit = limit(options.maxReadBytes, 64 * 1024, "maxReadBytes");
  if (readLimit < 4) throw new RuntimeError("INVALID_ARGUMENT", "maxReadBytes must be at least 4");
  const directoryLimit = limit(options.maxDirectoryEntries, 200, "maxDirectoryEntries");
  const environmentId = Type.String({ minLength: 1, description: "Registered environment ID from runtime_list_environments" });
  const path = Type.String({ minLength: 1, description: "Path in the selected environment; relative to its configured cwd or absolute" });
  const namespace = { name: "runtime", description: "Files and commands in explicitly selected execution environments" };
  const guidelines = [
    "Discover environment IDs with runtime_list_environments. Select environmentId explicitly for every operation.",
    "Use the same environmentId for related file and command operations. Paths belong to that environment.",
  ];

  return [
    tool({
      name: "runtime_list_environments", label: "List environments",
      description: "List host-registered execution environments and their working directories.",
      promptSnippet: "Discover available execution environments",
      parameters: Type.Object({}), namespace,
      annotations: { readOnlyHint: true, openWorldHint: false },
      async execute() {
        return success("listEnvironments", undefined, runtime.listEnvironments());
      },
    }),
    tool({
      name: "runtime_exec", label: "Run command in environment",
      description: "Execute a one-shot shell command in the selected environment. Returns exit code, stdout and stderr. Non-zero exit codes are errors. Each call starts in the configured cwd unless cwd is supplied; cd and exports do not persist between calls.",
      promptSnippet: "Run shell commands in a selected environment", promptGuidelines: guidelines,
      parameters: Type.Object({
        environmentId, command: Type.String({ minLength: 1 }),
        cwd: Type.Optional(path),
        env: Type.Optional(Type.Record(Type.String(), Type.String())),
        timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_147_483_647, description: "Timeout in milliseconds; default 60000" })),
      }), namespace,
      async execute(_id, params, signal, onUpdate) {
        return report("exec", params.environmentId, async () => {
          const result = await runtime.exec(params.environmentId, {
            command: params.command,
            ...(params.cwd === undefined ? {} : { cwd: params.cwd }),
            ...(params.env === undefined ? {} : { env: params.env }),
            ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
            ...(signal === undefined ? {} : { signal }),
            maxOutputBytes: outputLimit,
            onOutput: (output) => {
              // Bound individual UI updates too; the final result retains the configured preview.
              onUpdate?.({
                content: [{ type: "text", text: `[${params.environmentId}:${output.stream}] ${output.data.slice(0, 8192)}` }],
                details: { operation: "exec", environmentId: params.environmentId, status: "running" },
              });
            },
          });
          const response = success("exec", params.environmentId, result);
          const failed = result.exitCode !== 0;
          return { ...response, details: { ...response.details, status: failed ? "error" : "success" }, isError: failed };
        });
      },
    }),
    tool({
      name: "runtime_read_file", label: "Read file in environment",
      description: "Read a bounded UTF-8 text preview in the selected environment. offset is a zero-based byte offset; use returned nextOffset to continue when truncated. Binary files require the SDK's byte API.",
      promptSnippet: "Read text files in a selected environment",
      parameters: Type.Object({
        environmentId, path,
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
        maxBytes: Type.Optional(Type.Integer({ minimum: 4, maximum: readLimit })),
      }), namespace,
      annotations: { readOnlyHint: true, openWorldHint: false },
      async execute(_id, params, signal) {
        return report("readFile", params.environmentId, async () => {
          const offset = params.offset ?? 0;
          const maxBytes = params.maxBytes ?? readLimit;
          if (maxBytes < 4) throw new RuntimeError("INVALID_ARGUMENT", "UTF-8 preview needs at least 4 bytes");
          const raw = await runtime.readFile(params.environmentId, params.path, {
            offset, length: maxBytes + 1, ...(signal === undefined ? {} : { signal }),
          });
          const preview = raw.subarray(0, maxBytes);
          let text: string;
          try {
            text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(preview, { stream: raw.length > maxBytes });
            if (text.includes("\0")) throw new Error("Binary content");
          } catch (error) {
            throw new RuntimeError("INVALID_ARGUMENT", "File is not valid UTF-8 text, or offset is inside a character; use the binary SDK API", error);
          }
          const bytesRead = Buffer.byteLength(text, "utf8");
          return success("readFile", params.environmentId, {
            path: params.path, text, offset, bytesRead, nextOffset: offset + bytesRead,
            truncated: raw.length > bytesRead,
          });
        });
      },
    }),
    tool({
      name: "runtime_write_file", label: "Write file in environment",
      description: "Write or overwrite a UTF-8 text file in the selected environment. Parent directories must exist; use runtime_mkdir to create them.",
      promptSnippet: "Write text files in a selected environment",
      parameters: Type.Object({ environmentId, path, content: Type.String() }), namespace,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      executionMode: "sequential",
      async execute(_id, params, signal) {
        return report("writeFile", params.environmentId, async () => {
          await runtime.writeFile(params.environmentId, params.path, params.content, signal === undefined ? {} : { signal });
          return success("writeFile", params.environmentId, { path: params.path, bytesWritten: Buffer.byteLength(params.content) });
        });
      },
    }),
    tool({
      name: "runtime_list_directory", label: "List directory in environment",
      description: `List directory entries in the selected environment, up to ${directoryLimit} entries. Use runtime_exec for filtering a large directory.`,
      parameters: Type.Object({ environmentId, path: Type.Optional(path) }), namespace,
      annotations: { readOnlyHint: true, openWorldHint: false },
      async execute(_id, params, signal) {
        return report("listDirectory", params.environmentId, async () => {
          const entries = await runtime.listDirectory(params.environmentId, params.path ?? ".", signal === undefined ? {} : { signal });
          return success("listDirectory", params.environmentId, {
            entries: entries.slice(0, directoryLimit), total: entries.length, truncated: entries.length > directoryLimit,
          });
        });
      },
    }),
    tool({
      name: "runtime_stat", label: "Inspect file in environment",
      description: "Get file type, size and modification time in the selected environment. Symbolic links are reported as links.",
      parameters: Type.Object({ environmentId, path }), namespace,
      annotations: { readOnlyHint: true, openWorldHint: false },
      async execute(_id, params, signal) {
        return report("stat", params.environmentId, async () => success(
          "stat", params.environmentId,
          await runtime.stat(params.environmentId, params.path, signal === undefined ? {} : { signal }),
        ));
      },
    }),
    tool({
      name: "runtime_mkdir", label: "Create directory in environment",
      description: "Create a directory in the selected environment. Set recursive to create missing parents.",
      parameters: Type.Object({ environmentId, path, recursive: Type.Optional(Type.Boolean()) }), namespace,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      async execute(_id, params, signal) {
        return report("mkdir", params.environmentId, async () => {
          await runtime.mkdir(params.environmentId, params.path, {
            recursive: params.recursive ?? false, ...(signal === undefined ? {} : { signal }),
          });
          return success("mkdir", params.environmentId, { path: params.path });
        });
      },
    }),
  ];
}

/** Use from a Pi extension factory; the host controls the registered environments. */
export function registerRuntimeTools(pi: ExtensionAPI, runtime: Runtime, options?: PiToolsOptions): void {
  for (const definition of createRuntimeTools(runtime, options)) pi.registerTool(definition);
}
