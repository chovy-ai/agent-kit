import { Effect } from "effect";
import { RunnerError } from "./protocol.js";

export function decodeReply<A>(value: unknown, decode: (value: unknown) => A): Effect.Effect<A, RunnerError> {
  return Effect.try({
    try: () => decode(value),
    catch: (cause) => cause instanceof RunnerError ? cause : new RunnerError("PROTOCOL_ERROR", "Invalid capability response", cause),
  });
}

export function recordReply(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected an object");
  return value as Record<string, unknown>;
}

export function stringReply(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected a string");
  return value;
}

export function integerReply(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error("Expected a safe integer");
  return value;
}

export function booleanReply(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("Expected a boolean");
  return value;
}

export function decimalReply(value: unknown): string {
  const text = stringReply(value);
  if (!/^(0|[1-9][0-9]*)$/.test(text) || BigInt(text) > 9223372036854775807n) throw new Error("Expected a nonnegative int64 string");
  return text;
}

export function base64Reply(value: unknown, maxBytes: number): Uint8Array {
  const text = stringReply(value);
  if (text.length > Math.ceil(maxBytes / 3) * 4) throw new Error("Byte response exceeds its limit");
  const bytes = Buffer.from(text, "base64");
  if (bytes.length > maxBytes || bytes.toString("base64") !== text) throw new Error("Invalid base64 bytes");
  return bytes;
}
