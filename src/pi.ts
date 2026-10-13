import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import type { ManagedRuntime } from "effect";
import { Type } from "typebox";
import { RuntimeClient } from "./runtime-client.js";
import { RunnerError } from "./protocol.js";
import type { JsonObject } from "./protocol.js";

export function createFrameworkTools(runtime: ManagedRuntime.ManagedRuntime<RuntimeClient, RunnerError>, methods: readonly string[] = []): ToolDefinition[] {
  const request = async (method: string, params: JsonObject, signal?: AbortSignal, onOutput?: (event: { stream: "stdout" | "stderr"; data: string }) => void) => runtime.runPromise(Effect.gen(function* () {
    const client = yield* RuntimeClient;
    return yield* client.request(method, params, onOutput === undefined ? {} : { onOutput });
  }), signal === undefined ? undefined : { signal });
  const result = (value: unknown, isError = false) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }], details: value, isError });
  const failure = (error: unknown) => result(error instanceof RunnerError ? { code: error.code, message: error.message, details: error.details } : error instanceof Error ? error.message : String(error), true);
  const guarded = async (action: () => Promise<unknown>) => { try { return result(await action()); } catch (error) { return failure(error); } };
  const environment = { environmentId: Type.String({ minLength: 1, description: "Registered environment ID, such as local or remote." }) };
  const tools: ToolDefinition[] = [defineTool({
    name: "agent_kit_status",
    label: "Agent Kit framework status",
    description: "Check the connected Go runner and report its available methods and output events.",
    parameters: Type.Object({}),
    annotations: { readOnlyHint: true, openWorldHint: false },
    async execute(_id, _params, signal) {
      try {
        const result = await runtime.runPromise(Effect.gen(function* () {
          const client = yield* RuntimeClient;
          return yield* client.hello;
        }), signal === undefined ? undefined : { signal });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
          details: undefined, isError: true,
        };
      }
    },
  })];
  if (methods.includes("environment.list")) tools.push(defineTool({
    name: "environment_list", label: "List execution environments", description: "List registered environment IDs before choosing a target for files and commands.", parameters: Type.Object({}), annotations: { readOnlyHint: true },
    execute: (_id, _params, signal) => guarded(() => request("environment.list", {}, signal)),
  }));
  if (methods.includes("filesystem.read")) tools.push(defineTool({
    name: "filesystem_read", label: "Read a file", description: "Read a file in the selected environment. Paths belong to that environment. Content is limited to 512 KiB; use byte offsets for slices.",
    parameters: Type.Object({ ...environment, path: Type.String(), offset: Type.Optional(Type.String({ pattern: "^[0-9]+$" })), length: Type.Optional(Type.Integer({ minimum: 1, maximum: 524288 })), encoding: Type.Optional(Type.Union([Type.Literal("utf8"), Type.Literal("base64")])) }), annotations: { readOnlyHint: true },
    execute: (_id, params, signal) => guarded(async () => { const { encoding, ...input } = params; const value = await request("filesystem.read", input, signal) as { data: string }; const bytes = Buffer.from(value.data, "base64"); return encoding === "base64" ? value.data : new TextDecoder("utf-8", { fatal: true }).decode(bytes); }),
  }));
  if (methods.includes("filesystem.write")) tools.push(defineTool({
    name: "filesystem_write", label: "Write a file", description: "Create or overwrite a file in the selected environment. Parent directories must exist. Maximum content is 512 KiB.",
    parameters: Type.Object({ ...environment, path: Type.String(), content: Type.String(), encoding: Type.Optional(Type.Union([Type.Literal("utf8"), Type.Literal("base64")])) }),
    execute: (_id, params, signal) => guarded(async () => { const bytes = Buffer.from(params.content, params.encoding === "base64" ? "base64" : "utf8"); if (bytes.length > 524288) throw new Error("File tool content limit is 512 KiB"); if (params.encoding === "base64" && bytes.toString("base64") !== params.content) throw new Error("Invalid base64 content"); return request("filesystem.write", { environmentId: params.environmentId, path: params.path, data: bytes.toString("base64") }, signal); }),
  }));
  if (methods.includes("filesystem.readDir")) tools.push(defineTool({
    name: "filesystem_read_dir", label: "List a directory", description: "List immediate entries in a directory in the selected environment.", parameters: Type.Object({ ...environment, path: Type.String() }), annotations: { readOnlyHint: true },
    execute: (_id, params, signal) => guarded(() => request("filesystem.readDir", params, signal)),
  }));
  if (methods.includes("filesystem.stat")) tools.push(defineTool({
    name: "filesystem_stat", label: "Inspect a path", description: "Read file type, byte size and modification time in the selected environment.", parameters: Type.Object({ ...environment, path: Type.String(), followSymlinks: Type.Optional(Type.Boolean()) }), annotations: { readOnlyHint: true },
    execute: (_id, params, signal) => guarded(() => request("filesystem.stat", params, signal)),
  }));
  if (methods.includes("filesystem.mkdir")) tools.push(defineTool({
    name: "filesystem_mkdir", label: "Create a directory", description: "Create a directory in the selected environment. Set recursive to create parent directories.", parameters: Type.Object({ ...environment, path: Type.String(), recursive: Type.Optional(Type.Boolean()) }),
    execute: (_id, params, signal) => guarded(() => request("filesystem.mkdir", params, signal)),
  }));
  if (methods.includes("process.exec")) tools.push(defineTool({
    name: "process_exec", label: "Run Bash in an environment", description: "Execute a one-time Bash command in the selected environment. Use it for complex file operations. No interactive stdin or persistent shell; managed background children are cleaned up.",
    parameters: Type.Object({ ...environment, command: Type.String({ minLength: 1 }), cwd: Type.Optional(Type.String()), env: Type.Optional(Type.Record(Type.String(), Type.String())), timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600000 })), maxOutputBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 8388608 })) }),
    async execute(_id, params, signal, onUpdate) {
      try {
        const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() }; let preview = "";
        const value = await request("process.exec", params, signal, (event) => { preview = (preview + decoders[event.stream].decode(Buffer.from(event.data, "base64"), { stream: true })).slice(-65536); onUpdate?.(result(preview)); }) as { stdout: string; stderr: string; exitCode: number | null; completion: string; executionError?: unknown; outputTruncated: boolean; outputIncomplete: boolean };
        const display = { ...value, stdout: new TextDecoder().decode(Buffer.from(value.stdout, "base64")), stderr: new TextDecoder().decode(Buffer.from(value.stderr, "base64")) };
        return result(display, value.completion !== "finished" || value.exitCode !== 0 || value.executionError !== undefined);
      } catch (error) { return failure(error); }
    },
  }));
  return tools;
}
