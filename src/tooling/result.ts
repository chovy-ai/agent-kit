import { RunnerError } from "../modules/go-bridge/index.js";

export const TOOL_DISPLAY_BYTES = 16384;

export function clipText(text: string, limit = TOOL_DISPLAY_BYTES, tail = false) {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= limit) return { text, bytes: bytes.length, truncated: false };
  let start = tail ? bytes.length - limit : 0;
  let end = tail ? bytes.length : limit;
  if (tail) while (start < end && (bytes[start]! & 0xc0) === 0x80) start++;
  else while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return { text: bytes.subarray(start, end).toString("utf8"), bytes: end - start, truncated: true };
}

export function toolResult(value: unknown, isError = false, details: unknown = value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const marker = "\n[Tool display truncated.]";
  const initial = clipText(text ?? "");
  const preview = initial.truncated ? clipText(text ?? "", TOOL_DISPLAY_BYTES - Buffer.byteLength(marker)) : initial;
  return {
    content: [{ type: "text" as const, text: preview.text + (preview.truncated ? marker : "") }],
    details, isError,
  };
}

export function toolFailure(error: unknown) {
  return toolResult(error instanceof RunnerError ? { code: error.code, details: error.details, message: clipText(error.message, 4096).text }
    : error instanceof Error ? error.message : String(error), true);
}

export async function guardedTool(action: () => Promise<unknown>) {
  try { return toolResult(await action()); }
  catch (error) { return toolFailure(error); }
}
