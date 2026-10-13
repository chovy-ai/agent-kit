import { Effect } from "effect";
import type { ManagedRuntime } from "effect";
import type { RuntimeClient, RunnerError } from "./modules/go-bridge/index.js";
import { createAgentTools } from "./modules/agent/index.js";
import type { AgentToolServices } from "./modules/agent/index.js";
import type { ToolRuntime } from "./tooling/index.js";
import { createCapabilityLayer } from "./bootstrap/layers.js";

// Compatibility for callers supplying a bridge-only runtime. The capability
// layers borrow its existing bridge and acquire no resources of their own.
export function createFrameworkTools(runtime: ManagedRuntime.ManagedRuntime<RuntimeClient, RunnerError>, methods: readonly string[] = []) {
  const capabilities = createCapabilityLayer();
  const adapter: ToolRuntime<AgentToolServices> = {
    runPromise: (effect, options) => runtime.runPromise(effect.pipe(Effect.provide(capabilities)), options),
  };
  return createAgentTools(adapter, methods);
}

export { createAgentTools } from "./modules/agent/index.js";
