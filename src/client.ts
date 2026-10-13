// Compatibility entry point. Consumers use runtime-client; startup selects stdio-client.
export { RuntimeClient } from "./runtime-client.js";
export type { ConnectionInfo, RuntimeClientService, RequestOptions } from "./runtime-client.js";
export { RunnerConfig, RuntimeClientLive, createRuntimeClientLayer } from "./stdio-client.js";
export type { RunnerOptions } from "./stdio-client.js";
