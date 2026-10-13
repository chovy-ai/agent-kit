import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolRuntime } from "../../tooling/index.js";
import type { RuntimeClient } from "../go-bridge/index.js";
import type { EnvironmentService } from "../environment/index.js";
import type { FilesystemService } from "../filesystem/index.js";
import type { ProcessService } from "../process/index.js";
import { createDiagnosticTools } from "./diagnostics.js";
import { createEnvironmentTools } from "../environment/tools.js";
import { createFilesystemTools } from "../filesystem/tools.js";
import { createProcessTools } from "../process/tools.js";

export type AgentToolServices = RuntimeClient | EnvironmentService | FilesystemService | ProcessService;

// This is the Pi adapter composition entry; tool execution only uses services.
export function createAgentTools(runtime: ToolRuntime<AgentToolServices>, methods: readonly string[] = []): ToolDefinition[] {
  return [...createDiagnosticTools(runtime), ...createEnvironmentTools(runtime, methods),
    ...createFilesystemTools(runtime, methods), ...createProcessTools(runtime, methods)];
}
