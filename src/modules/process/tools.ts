import { defineTool } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { Type } from "typebox";
import { environmentParameters, clipText, runTool, toolFailure, toolResult, TOOL_DISPLAY_BYTES } from "../../tooling/index.js";
import type { ToolRuntime } from "../../tooling/index.js";
import { ProcessService } from "./service.js";

export function createProcessTools(runtime: ToolRuntime<ProcessService>, methods: readonly string[]) {
  if (!methods.includes("process.exec")) return [];
  return [defineTool({
    name: "process_exec", label: "Run Bash in an environment",
    description: "Execute a one-time Bash command in the selected environment. Use it for complex file operations. No interactive stdin or persistent shell; managed background children are cleaned up. Capture and display truncation are reported separately.",
    parameters: Type.Object({ ...environmentParameters, command: Type.String({ minLength: 1 }), cwd: Type.Optional(Type.String()), env: Type.Optional(Type.Record(Type.String(), Type.String())), timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600000 })), maxOutputBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 8388608 })) }),
    async execute(_id, params, signal, onUpdate) {
      try {
        const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
        let progress = "";
        const value = await runTool(runtime, Effect.gen(function* () {
          return yield* (yield* ProcessService).exec(params, (event) => {
            progress = clipText(progress + decoders[event.stream].decode(event.data, { stream: true }), TOOL_DISPLAY_BYTES, true).text;
            onUpdate?.(toolResult(progress));
          });
        }), signal);
        const stdout = new TextDecoder().decode(value.stdout);
        const stderr = new TextDecoder().decode(value.stderr);
        let budget = stdout && stderr ? (TOOL_DISPLAY_BYTES - 4096) / 2 : TOOL_DISPLAY_BYTES - 4096;
        const presentation = (budget: number) => {
          const out = clipText(stdout, budget);
          const err = clipText(stderr, budget);
          return { ...value, environmentId: params.environmentId, stdout: out.text, stderr: err.text, displayTruncated: out.truncated || err.truncated };
        };
        let display = presentation(budget);
        // Account for JSON escaping as well as UTF-8, so completion fields and
        // truncation flags remain visible even for control-heavy output.
        while (budget > 0 && Buffer.byteLength(JSON.stringify(display)) > TOOL_DISPLAY_BYTES) {
          budget = Math.floor(budget / 2);
          display = presentation(budget);
        }
        return toolResult(display, value.completion !== "finished" || value.exitCode !== 0 || value.executionError !== undefined);
      } catch (error) { return toolFailure(error); }
    },
  })];
}
