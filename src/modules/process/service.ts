import { Context } from "effect";
import type { Effect } from "effect";
import type { JsonObject, RunnerError } from "../go-bridge/index.js";
import type { EnvironmentRef } from "../environment/index.js";

export interface ExecRequest extends EnvironmentRef {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxOutputBytes?: number;
}
export interface ProcessOutput { stream: "stdout" | "stderr"; data: Uint8Array; }
export interface ExecutionError { code: string; message: string; details?: JsonObject; }
export interface ExecResult {
  completion: "not_started" | "finished" | "unconfirmed";
  exitCode: number | null;
  signal: string;
  stdout: Uint8Array;
  stderr: Uint8Array;
  durationMs: number;
  outputTruncated: boolean;
  outputIncomplete: boolean;
  executionError?: ExecutionError;
}
export interface ProcessServiceApi {
  exec(request: ExecRequest, onOutput?: (output: ProcessOutput) => void): Effect.Effect<ExecResult, RunnerError>;
}

export class ProcessService extends Context.Service<ProcessService, ProcessServiceApi>()("agent-kit/ProcessService") {}
