import { defineTool } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { Type } from "typebox";
import { runTool, guardedTool } from "../../tooling/index.js";
import type { ToolRuntime } from "../../tooling/index.js";
import { RuntimeClient } from "../go-bridge/index.js";

export function createDiagnosticTools(runtime: ToolRuntime<RuntimeClient>) {
  return [defineTool({
    name: "agent_kit_status", label: "Agent Kit framework status",
    description: "Check the connected Go runner and report its available methods and output events.",
    parameters: Type.Object({}), annotations: { readOnlyHint: true, openWorldHint: false },
    execute: (_id, _params, signal) => guardedTool(() => runTool(runtime, Effect.gen(function* () {
      return yield* (yield* RuntimeClient).hello;
    }), signal)),
  })];
}
