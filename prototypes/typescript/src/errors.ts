export type RuntimeErrorCode =
  | "INVALID_ARGUMENT"
  | "UNKNOWN_ENVIRONMENT"
  | "DUPLICATE_ENVIRONMENT"
  | "CANCELLED"
  | "TIMEOUT"
  | "EXECUTION_FAILED"
  | "FILE_NOT_FOUND"
  | "PERMISSION_DENIED"
  | "IO_ERROR"
  | "ADAPTER_ERROR";

export class RuntimeError extends Error {
  readonly code: RuntimeErrorCode;

  constructor(code: RuntimeErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "RuntimeError";
    this.code = code;
  }
}

export function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new RuntimeError("CANCELLED", "Operation cancelled", signal.reason);
  }
}

export function normalizeError(error: unknown, fallback: RuntimeErrorCode): RuntimeError {
  if (error instanceof RuntimeError) return error;
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  const message = error instanceof Error ? error.message : String(error);
  if (code === "ENOENT") return new RuntimeError("FILE_NOT_FOUND", message, error);
  if (code === "EACCES" || code === "EPERM") return new RuntimeError("PERMISSION_DENIED", message, error);
  if (code === "ABORT_ERR") return new RuntimeError("CANCELLED", message, error);
  return new RuntimeError(fallback, message, error);
}
