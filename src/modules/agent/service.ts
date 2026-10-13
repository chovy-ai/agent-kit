import { Context } from "effect";
import type { Effect } from "effect";
import type { AgentSession, CreateAgentSessionOptions, CreateAgentSessionResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { RunnerError } from "../go-bridge/index.js";

// Session consumers configure Pi; the application controls the tool allowlist.
export type AgentSessionOptions = Omit<CreateAgentSessionOptions, "tools" | "customTools" | "noTools">;
export type AgentSessionResult = CreateAgentSessionResult;
export type { AgentSession };

export interface AgentServiceApi {
  createSession(options: AgentSessionOptions, tools: ToolDefinition[]): Effect.Effect<AgentSessionResult, RunnerError>;
  closeSession(session: AgentSession): Effect.Effect<void, RunnerError>;
}
export interface AgentSessionFactoryApi {
  create(options: CreateAgentSessionOptions, signal?: AbortSignal): Promise<AgentSessionResult>;
}

export class AgentService extends Context.Service<AgentService, AgentServiceApi>()("agent-kit/AgentService") {}
export class AgentSessionFactory extends Context.Service<AgentSessionFactory, AgentSessionFactoryApi>()("agent-kit/AgentSessionFactory") {}
