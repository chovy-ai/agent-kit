import { Effect, ManagedRuntime } from "effect";
import type { Layer } from "effect";
import { RuntimeClient } from "./runtime-client.js";
import { createRuntimeClientLayer } from "./stdio-client.js";
import type { RunnerOptions } from "./stdio-client.js";
import { createFrameworkTools } from "./pi.js";
import type { RunnerError } from "./protocol.js";

export async function createAgentKit(
  options: RunnerOptions = {},
  clientLayer: Layer.Layer<RuntimeClient, RunnerError> = createRuntimeClientLayer(options),
) {
  const runtime = ManagedRuntime.make(clientLayer);
  try {
    const hello = await runtime.runPromise(Effect.gen(function* () {
      const client = yield* RuntimeClient;
      return yield* client.hello;
    }));
    let closing: Promise<void> | undefined;
    return { runtime, hello, tools: createFrameworkTools(runtime, hello.methods), close: () => closing ??= runtime.dispose() };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}
