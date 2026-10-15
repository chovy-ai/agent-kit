import { Context } from "effect";
import type { Effect } from "effect";
import type { HelloResult, JsonObject, OutputEvent, RunnerError } from "./protocol.js";

export interface ConnectionInfo {
  pid: number | undefined;
  pendingRequests: number;
  closed: boolean;
  confirmedCancellations: number;
}

export interface RuntimeClientService {
  request(method: string, params?: JsonObject, options?: RequestOptions): Effect.Effect<unknown, RunnerError>;
  hello: Effect.Effect<HelloResult, RunnerError>;
  ping(delayMs?: number): Effect.Effect<{ ok: true }, RunnerError>;
  connectionInfo: Effect.Effect<ConnectionInfo>;
}

export interface RequestOptions { timeoutMs?: number; onOutput?: (event: OutputEvent["data"]) => void; }

export class RuntimeClient extends Context.Service<RuntimeClient, RuntimeClientService>()("agent-kit/RuntimeClient") {}

export interface RunnerOptions {
  runnerPath?: string;
  args?: string[];
  configPath?: string;
  environments?: Record<string, LocalEnvironmentConfig>;
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  maxMessageBytes?: number;
  maxPendingRequests?: number;
}

export interface LocalEnvironmentConfig {
  type: "local";
  cwd?: string;
  bash?: string;
}

export class RunnerConfig extends Context.Service<RunnerConfig, RunnerOptions>()("agent-kit/RunnerConfig") {}
