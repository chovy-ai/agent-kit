import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { Type } from "typebox";
import { environmentParameters, clipText, guardedTool, runTool, toolFailure, toolResult, TOOL_DISPLAY_BYTES } from "../../tooling/index.js";
import type { ToolRuntime } from "../../tooling/index.js";
import { FilesystemService } from "./service.js";

export function createFilesystemTools(runtime: ToolRuntime<FilesystemService>, methods: readonly string[]): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  if (methods.includes("filesystem.read")) tools.push(defineTool({
    name: "filesystem_read", label: "Read a file",
    description: "Read a file in the selected environment. Paths belong to that environment. Content is limited to 512 KiB; offset and length are bytes. Large displays include a continuation offset.",
    parameters: Type.Object({ ...environmentParameters, path: Type.String(), offset: Type.Optional(Type.String({ pattern: "^[0-9]+$" })), length: Type.Optional(Type.Integer({ minimum: 1, maximum: 524288 })), encoding: Type.Optional(Type.Union([Type.Literal("utf8"), Type.Literal("base64")])) }),
    annotations: { readOnlyHint: true },
    async execute(_id, params, signal) {
      try {
        const { encoding, ...request } = params;
        const { data } = await runTool(runtime, Effect.gen(function* () { return yield* (yield* FilesystemService).read(request); }), signal);
        const text = encoding === "base64" ? Buffer.from(data).toString("base64") : new TextDecoder("utf8", { fatal: true }).decode(data);
        const budget = TOOL_DISPLAY_BYTES - 512;
        const preview = encoding === "base64" ? { text: text.slice(0, budget), truncated: text.length > budget, bytes: Buffer.from(text.slice(0, budget), "base64").length } : clipText(text, budget);
        const nextOffset = (BigInt(params.offset ?? "0") + BigInt(preview.bytes)).toString();
        const note = preview.truncated ? `\n[Display truncated. Continue with offset=${nextOffset} in the same environment and path.]` : "";
        return toolResult(preview.text + note, false, { ...request, encoding: encoding ?? "utf8", bytesRead: data.byteLength, displayTruncated: preview.truncated, ...(preview.truncated ? { nextOffset } : {}) });
      } catch (error) { return toolFailure(error); }
    },
  }));
  if (methods.includes("filesystem.write")) tools.push(defineTool({
    name: "filesystem_write", label: "Write a file",
    description: "Create or overwrite a file in the selected environment. Parent directories must exist. Maximum content is 512 KiB.",
    parameters: Type.Object({ ...environmentParameters, path: Type.String(), content: Type.String(), encoding: Type.Optional(Type.Union([Type.Literal("utf8"), Type.Literal("base64")])) }),
    execute: (_id, params, signal) => guardedTool(async () => {
      const data = Buffer.from(params.content, params.encoding === "base64" ? "base64" : "utf8");
      if (data.length > 524288) throw new Error("File tool content limit is 512 KiB");
      if (params.encoding === "base64" && data.toString("base64") !== params.content) throw new Error("Invalid base64 content");
      return runTool(runtime, Effect.gen(function* () { return yield* (yield* FilesystemService).write({ environmentId: params.environmentId, path: params.path, data }); }), signal);
    }),
  }));
  if (methods.includes("filesystem.readDir")) tools.push(defineTool({
    name: "filesystem_read_dir", label: "List a directory", description: "List immediate entries in a directory in the selected environment.",
    parameters: Type.Object({ ...environmentParameters, path: Type.String() }), annotations: { readOnlyHint: true },
    execute: (_id, params, signal) => guardedTool(() => runTool(runtime, Effect.gen(function* () { return yield* (yield* FilesystemService).readDir(params); }), signal)),
  }));
  if (methods.includes("filesystem.stat")) tools.push(defineTool({
    name: "filesystem_stat", label: "Inspect a path", description: "Read file type, byte size and modification time in the selected environment.",
    parameters: Type.Object({ ...environmentParameters, path: Type.String(), followSymlinks: Type.Optional(Type.Boolean()) }), annotations: { readOnlyHint: true },
    execute: (_id, params, signal) => guardedTool(() => runTool(runtime, Effect.gen(function* () { return yield* (yield* FilesystemService).stat(params); }), signal)),
  }));
  if (methods.includes("filesystem.mkdir")) tools.push(defineTool({
    name: "filesystem_mkdir", label: "Create a directory", description: "Create a directory in the selected environment. Set recursive to create parent directories.",
    parameters: Type.Object({ ...environmentParameters, path: Type.String(), recursive: Type.Optional(Type.Boolean()) }),
    execute: (_id, params, signal) => guardedTool(() => runTool(runtime, Effect.gen(function* () { return yield* (yield* FilesystemService).mkdir(params); }), signal)),
  }));
  return tools;
}
