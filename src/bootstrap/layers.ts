import { Layer } from "effect";
import type { RuntimeClient, RunnerError } from "../modules/go-bridge/index.js";
import type { EnvironmentService } from "../modules/environment/index.js";
import type { FilesystemService } from "../modules/filesystem/index.js";
import type { ProcessService } from "../modules/process/index.js";
import type { AgentSessionFactory } from "../modules/agent/index.js";
import { EnvironmentLive } from "../modules/environment/live.js";
import { FilesystemLive } from "../modules/filesystem/live.js";
import { ProcessLive } from "../modules/process/live.js";
import { AgentLive, AgentSessionFactoryLive } from "../modules/agent/live.js";

export interface AgentKitLayers {
  environment?: Layer.Layer<EnvironmentService, RunnerError, RuntimeClient>;
  filesystem?: Layer.Layer<FilesystemService, RunnerError, RuntimeClient>;
  process?: Layer.Layer<ProcessService, RunnerError, RuntimeClient>;
  sessionFactory?: Layer.Layer<AgentSessionFactory, RunnerError, RuntimeClient>;
}

// Each dependency is provided once into one graph, including replacement layers.
export function createCapabilityLayer(layers: AgentKitLayers = {}) {
  return Layer.mergeAll(layers.environment ?? EnvironmentLive, layers.filesystem ?? FilesystemLive, layers.process ?? ProcessLive);
}

export function createApplicationLayer(clientLayer: Layer.Layer<RuntimeClient, RunnerError>, layers: AgentKitLayers = {}) {
  const capabilities = createCapabilityLayer(layers).pipe(Layer.provideMerge(clientLayer));
  return AgentLive.pipe(Layer.provide(layers.sessionFactory ?? AgentSessionFactoryLive), Layer.provideMerge(capabilities));
}
