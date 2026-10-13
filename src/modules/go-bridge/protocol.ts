export const PROTOCOL_VERSION = 1;

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface HelloResult {
  name: string;
  protocolVersion: number;
  methods: string[];
  events?: string[];
}

export interface OutputEvent {
  version: 1;
  id: string;
  type: "event";
  event: "process.output";
  data: { stream: "stdout" | "stderr"; data: string };
}

export interface Response {
  version: 1;
  id: string;
  type: "result" | "error";
  result?: unknown;
  error?: { code: string; message: string; details?: JsonObject };
}

export class RunnerError extends Error {
  readonly _tag = "RunnerError";
  constructor(readonly code: string, message: string, cause?: unknown, readonly details?: JsonObject) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "RunnerError";
  }
}

export function asRunnerError(error: unknown): RunnerError {
  return error instanceof RunnerError ? error : new RunnerError("CLIENT_ERROR", error instanceof Error ? error.message : String(error), error);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseResponse(value: unknown): Response | OutputEvent {
  if (!record(value) || value.version !== PROTOCOL_VERSION || typeof value.id !== "string" || value.id.length === 0) {
    throw new RunnerError("PROTOCOL_ERROR", "Invalid response identity or protocol version");
  }
  if (value.type === "event" && value.event === "process.output" && record(value.data)
      && (value.data.stream === "stdout" || value.data.stream === "stderr") && typeof value.data.data === "string"
      && !('result' in value) && !('error' in value)) {
    const bytes = Buffer.from(value.data.data, "base64");
    if (bytes.length === 0 || bytes.length > 65536 || bytes.toString("base64") !== value.data.data) throw new RunnerError("PROTOCOL_ERROR", "Invalid output byte encoding");
    return { version: 1, id: value.id, type: "event", event: "process.output", data: { stream: value.data.stream, data: value.data.data } };
  }
  if (value.type === "result" && "result" in value && !("error" in value)) {
    return { version: 1, id: value.id, type: "result", result: value.result };
  }
  if (value.type === "error" && record(value.error) && typeof value.error.code === "string" && typeof value.error.message === "string" && !("result" in value)) {
    if (value.error.details !== undefined && !record(value.error.details)) throw new RunnerError("PROTOCOL_ERROR", "Invalid error details");
    return { version: 1, id: value.id, type: "error", error: { code: value.error.code, message: value.error.message, ...(value.error.details === undefined ? {} : { details: value.error.details as JsonObject }) } };
  }
  throw new RunnerError("PROTOCOL_ERROR", "Invalid response payload");
}

export function parseHello(value: unknown): HelloResult {
  if (!record(value) || value.name !== "agent-kit" || value.protocolVersion !== PROTOCOL_VERSION || !Array.isArray(value.methods) || !value.methods.every((method) => typeof method === "string")) {
    throw new RunnerError("PROTOCOL_ERROR", "Runner handshake is incompatible");
  }
  for (const required of ["system.hello", "system.ping", "request.cancel", "system.shutdown"]) {
    if (!value.methods.includes(required)) throw new RunnerError("PROTOCOL_ERROR", `Runner does not support ${required}`);
  }
  const events = value.events;
  if (events !== undefined && (!Array.isArray(events) || !events.every((event) => typeof event === "string"))) throw new RunnerError("PROTOCOL_ERROR", "Invalid event capabilities");
  return { name: value.name, protocolVersion: value.protocolVersion, methods: value.methods, ...(events === undefined ? {} : { events }) };
}
