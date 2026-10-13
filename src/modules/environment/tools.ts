import { defineTool } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { Type } from "typebox";
import { guardedTool, runTool } from "../../tooling/index.js";
import type { ToolRuntime } from "../../tooling/index.js";
import { EnvironmentService } from "./service.js";

export function createEnvironmentTools(runtime: ToolRuntime<EnvironmentService>, methods: readonly string[]) {
  if (!methods.includes("environment.list")) return [];
  return [defineTool({
    name: "environment_list", label: "List execution environments",
    description: "List registered environment IDs before choosing a target for files and commands.",
    parameters: Type.Object({}), annotations: { readOnlyHint: true },
    execute: (_id, _params, signal) => guardedTool(() => runTool(runtime, Effect.gen(function* () {
      return yield* (yield* EnvironmentService).list();
    }), signal)),
  })];
}
