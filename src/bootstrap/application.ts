import { Effect, ManagedRuntime } from "effect";
import type { Layer } from "effect";
import { RuntimeClient, RunnerError } from "../modules/go-bridge/index.js";
import type { RunnerOptions } from "../modules/go-bridge/index.js";
import { createRuntimeClientLayer } from "../modules/go-bridge/live.js";
import { AgentService, createAgentTools } from "../modules/agent/index.js";
import type { AgentSession, AgentSessionOptions } from "../modules/agent/index.js";
import { createApplicationLayer } from "./layers.js";
import type { AgentKitLayers } from "./layers.js";

export async function createAgentKit(
  options: RunnerOptions = {},
  clientLayer: Layer.Layer<RuntimeClient, RunnerError> = createRuntimeClientLayer(options),
  layers: AgentKitLayers = {},
) {
  const runtime = ManagedRuntime.make(createApplicationLayer(clientLayer, layers));
  try {
    const hello = await runtime.runPromise(Effect.gen(function* () { return yield* (yield* RuntimeClient).hello; }));
    const tools = createAgentTools(runtime, hello.methods);
    let closing: Promise<void> | undefined;
    return {
      runtime, hello, tools,
      createSession: (options: AgentSessionOptions = {}, signal?: AbortSignal) => closing !== undefined
        ? Promise.reject(new RunnerError("APPLICATION_CLOSED", "Agent application is closing")) : runtime.runPromise(Effect.gen(function* () {
        return yield* (yield* AgentService).createSession(options, tools);
      }), signal === undefined ? undefined : { signal }),
      closeSession: (session: AgentSession) => runtime.runPromise(Effect.gen(function* () { return yield* (yield* AgentService).closeSession(session); })),
      close: () => closing ??= runtime.dispose(),
    };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}

export interface PiAgentOptions {
  runner?: RunnerOptions;
  session?: AgentSessionOptions;
}

// One public startup path owns both Pi and its Go SDK bridge.
export async function createPiAgent(options: PiAgentOptions = {}, clientLayer?: Layer.Layer<RuntimeClient, RunnerError>, layers: AgentKitLayers = {}) {
  const app = await createAgentKit(options.runner ?? {}, clientLayer, layers);
  try {
    const created = await app.createSession(options.session);
    return { ...app, ...created };
  } catch (error) {
    await app.close();
    throw error;
  }
}
