import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Effect, Layer } from "effect";
import { asRunnerError, parseHello, parseResponse, PROTOCOL_VERSION, RunnerError } from "./protocol.js";
import type { JsonObject } from "./protocol.js";
import { RunnerConfig, RuntimeClient } from "./service.js";
import type { ConnectionInfo, RequestOptions, RunnerOptions } from "./service.js";

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: RunnerError): void;
  output?: { stdout: Buffer[]; stderr: Buffer[]; retained: number; limit: number; truncated: boolean; callbackError?: RunnerError; completion?: string } | undefined;
  onOutput?: RequestOptions["onOutput"] | undefined;
  completion?: Promise<unknown>;
}

interface RequestHandle {
  id: string;
  promise: Promise<unknown>;
}

function positive(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > 2_147_483_647) {
    throw new RunnerError("INVALID_CONFIG", `${name} must be a positive integer at most 2147483647`);
  }
  return resolved;
}

async function deadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new RunnerError("TIMEOUT", `Runner did not respond within ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Owns only the Go bridge process. All target environment execution will live in Go. */
class StdioConnection {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly exit: Promise<void>;
  private readonly timeoutMs: number;
  private readonly shutdownMs: number;
  private readonly messageLimit: number;
  private readonly pendingLimit: number;
  private input: Buffer = Buffer.alloc(0);
  private stderr: Buffer = Buffer.alloc(0);
  private failure: RunnerError | undefined;
  private closing: Promise<void> | undefined;
  private ended = false;
  private confirmedCancellations = 0;

  constructor(options: RunnerOptions) {
    this.timeoutMs = positive(options.requestTimeoutMs, 5000, "requestTimeoutMs");
    this.shutdownMs = positive(options.shutdownTimeoutMs, 2000, "shutdownTimeoutMs");
    this.messageLimit = positive(options.maxMessageBytes, 1024 * 1024, "maxMessageBytes");
    this.pendingLimit = positive(options.maxPendingRequests, 64, "maxPendingRequests");
    const runnerPath = options.runnerPath ?? process.env.AGENT_KIT_RUNNER ?? fileURLToPath(new URL("../../../.build/runtime-runner", import.meta.url));
    if (!runnerPath.trim() || runnerPath.includes("\0")) throw new RunnerError("INVALID_CONFIG", "runnerPath must be non-empty");
    this.child = spawn(runnerPath, options.args ?? [], { stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.on("data", (chunk: Buffer) => this.read(chunk));
    this.child.stdout.on("error", (error) => this.fail(new RunnerError("CONNECTION_CLOSED", "Runner output failed", error)));
    this.child.stdin.on("error", (error) => this.fail(new RunnerError("CONNECTION_CLOSED", "Runner input failed", error)));
    this.child.stderr.on("data", (chunk: Buffer) => { this.stderr = Buffer.concat([this.stderr, chunk]).subarray(-4096); });
    this.child.stderr.on("error", (error) => this.fail(new RunnerError("CONNECTION_CLOSED", "Runner log stream failed", error)));
    this.child.on("error", (error) => this.fail(new RunnerError("STARTUP_FAILED", error.message, error)));
    this.exit = new Promise((resolve) => {
      this.child.once("close", (code, signal) => {
        this.ended = true;
        if (this.pending.size || !this.closing || code !== 0 || signal !== null) {
          this.fail(new RunnerError("CONNECTION_CLOSED", `Runner exited (code=${code}, signal=${signal}): ${this.stderr.toString("utf8")}`));
        }
        resolve();
      });
    });
  }

  readonly info = (): ConnectionInfo => ({
    pid: this.child.pid, pendingRequests: this.pending.size,
    closed: this.ended || this.failure !== undefined, confirmedCancellations: this.confirmedCancellations,
  });

  request(method: string, params: JsonObject = {}, options: RequestOptions = {}): Effect.Effect<unknown, RunnerError> {
    const budget = options.timeoutMs ?? (method === "process.exec" ? (typeof params.timeoutMs === "number" && params.timeoutMs > 0 ? params.timeoutMs : 60000) + 5000 : method.startsWith("filesystem.") ? 12000 : this.timeoutMs);
    if (!Number.isSafeInteger(budget) || budget <= 0 || budget > 2147483647) return Effect.fail(new RunnerError("INVALID_CONFIG", "Request timeout must be a positive integer at most 2147483647"));
    const effect = Effect.gen({ self: this }, function* () {
      const handle = yield* Effect.try({ try: () => this.dispatch(method, params, false, options), catch: asRunnerError });
      return yield* Effect.tryPromise({ try: () => handle.promise, catch: asRunnerError }).pipe(
        Effect.onInterrupt(() => Effect.tryPromise({ try: () => this.cancelAndWait(handle), catch: asRunnerError })),
      );
    });
    return effect.pipe(
      Effect.timeout(budget),
      Effect.mapError((error) => error instanceof RunnerError ? error : new RunnerError("TIMEOUT", `Request exceeded ${budget} ms`, error)),
    );
  }

  close(): Promise<void> {
    return this.closing ??= this.closeResource();
  }

  private dispatch(method: string, params: JsonObject, control = false, options: RequestOptions = {}): RequestHandle {
    if (this.failure) throw this.failure;
    if (this.ended || (this.closing && !control)) throw new RunnerError("CONNECTION_CLOSED", "Runner connection is closing");
    if (!control && this.pending.size >= this.pendingLimit) throw new RunnerError("BUSY", "Client pending request limit reached");
    const id = randomUUID();
    const frame = JSON.stringify({ version: PROTOCOL_VERSION, id, method, params }) + "\n";
    if (Buffer.byteLength(frame) > this.messageLimit) throw new RunnerError("MESSAGE_TOO_LARGE", "Request exceeds message limit");
    const promise = new Promise<unknown>((resolve, reject) => {
      const output = method === "process.exec" ? { stdout: [] as Buffer[], stderr: [] as Buffer[], retained: 0, limit: typeof params.maxOutputBytes === "number" && params.maxOutputBytes > 0 ? Math.min(params.maxOutputBytes, 8 * 1024 * 1024) : 1024 * 1024, truncated: false } : undefined;
      this.pending.set(id, { resolve, reject, output, onOutput: options.onOutput });
      this.child.stdin.write(frame, (error) => {
        if (error) this.fail(new RunnerError("CONNECTION_CLOSED", "Cannot write runner request", error));
      });
    });
    // A request can fail before its Effect starts waiting for the Promise.
    const pending = this.pending.get(id);
    if (pending) pending.completion = promise;
    void promise.catch(() => {});
    return { id, promise };
  }

  private async cancelAndWait(handle: RequestHandle): Promise<void> {
    const pending = this.pending.get(handle.id);
    if (!pending) return;
    try {
      const control = this.dispatch("request.cancel", { requestId: handle.id }, true);
      await deadline(Promise.all([control.promise, handle.promise.catch(() => undefined)]), pending.output ? Math.max(this.shutdownMs, 5000) : this.shutdownMs);
      if (pending.output && pending.output.completion !== "finished" && pending.output.completion !== "not_started") throw new RunnerError("OUTCOME_UNKNOWN", "Target cleanup was not confirmed");
      this.confirmedCancellations++;
    } catch (error) {
      if (pending.output) throw new RunnerError("CANCELLATION_FAILED", "Could not confirm execution cancellation", error);
      this.fail(new RunnerError("CANCELLATION_FAILED", "Could not confirm runner cancellation", error));
      throw this.failure;
    }
  }

  private read(chunk: Buffer): void {
    if (this.failure) return;
    this.input = Buffer.concat([this.input, chunk]);
    let newline: number;
    while ((newline = this.input.indexOf(10)) !== -1) {
      if (newline > this.messageLimit) return this.fail(new RunnerError("PROTOCOL_ERROR", "Runner response exceeds message limit"));
      const line = this.input.subarray(0, newline);
      this.input = this.input.subarray(newline + 1);
      try {
        const response = parseResponse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)));
        const pending = this.pending.get(response.id);
        if (!pending) throw new RunnerError("PROTOCOL_ERROR", "Response has no matching request");
        if (response.type === "event") {
          if (!pending.output) throw new RunnerError("PROTOCOL_ERROR", "Output event for non-execution request");
          const bytes = Buffer.from(response.data.data, "base64");
          const keep = Math.min(bytes.length, pending.output.limit - pending.output.retained);
          if (keep > 0) pending.output[response.data.stream].push(Buffer.from(bytes.subarray(0, keep)));
          pending.output.retained += keep;
          pending.output.truncated ||= keep < bytes.length;
          if (!pending.output.callbackError) {
            try { pending.onOutput?.(response.data); }
            catch (error) {
              pending.output.callbackError = new RunnerError("OUTPUT_FAILED", "Output callback failed", error);
              void this.cancelAndWait({ id: response.id, promise: pending.completion! }).catch(() => {});
            }
          }
          continue;
        }
        this.pending.delete(response.id);
        if (response.type === "error") { if (pending.output) pending.output.completion = "not_started"; pending.reject(new RunnerError(response.error!.code, response.error!.message, undefined, response.error!.details)); }
        else if (pending.output) {
          if (typeof response.result === "object" && response.result !== null && "completion" in response.result && typeof response.result.completion === "string") pending.output.completion = response.result.completion;
          if (pending.output.callbackError) pending.reject(pending.output.callbackError);
          else if (typeof response.result !== "object" || response.result === null) throw new RunnerError("PROTOCOL_ERROR", "Invalid process terminal");
          else pending.resolve({ ...response.result, stdout: Buffer.concat(pending.output.stdout).toString("base64"), stderr: Buffer.concat(pending.output.stderr).toString("base64"), outputTruncated: pending.output.truncated || (response.result as { outputTruncated?: boolean }).outputTruncated === true });
        } else pending.resolve(response.result);
      } catch (error) {
        return this.fail(new RunnerError("PROTOCOL_ERROR", "Invalid runner response", error));
      }
    }
    if (this.input.length > this.messageLimit) this.fail(new RunnerError("PROTOCOL_ERROR", "Unterminated runner response exceeds message limit"));
  }

  private fail(error: RunnerError): void {
    this.failure ??= error;
    for (const pending of this.pending.values()) pending.reject(this.failure);
    this.pending.clear();
    if (!this.ended) this.child.kill("SIGKILL");
  }

  private async closeResource(): Promise<void> {
    if (!this.ended && !this.failure) {
      try {
        const shutdown = this.dispatch("system.shutdown", {}, true);
        await deadline(shutdown.promise, this.shutdownMs);
        this.child.stdin.end();
        await deadline(this.exit, this.shutdownMs);
      } catch (error) {
        this.fail(new RunnerError("CONNECTION_CLOSED", "Runner shutdown failed", error));
      }
    }
    if (!this.ended) {
      this.child.kill("SIGKILL");
      await deadline(this.exit, this.shutdownMs);
    }
    this.child.stdin.destroy();
    this.child.stdout.destroy();
    this.child.stderr.destroy();
    this.input = Buffer.alloc(0);
    this.stderr = Buffer.alloc(0);
  }
}

export const RuntimeClientLive = Layer.effect(RuntimeClient, Effect.gen(function* () {
  const options = yield* RunnerConfig;
  const connection = yield* Effect.acquireRelease(
    Effect.try({ try: () => new StdioConnection(options), catch: asRunnerError }),
    (connection) => Effect.promise(() => connection.close()),
  );
  const hello = connection.request("system.hello").pipe(
    Effect.flatMap((value) => Effect.try({ try: () => parseHello(value), catch: asRunnerError })),
  );
  const ready = yield* hello;
  return {
    request: (method: string, params?: JsonObject, options?: RequestOptions) => connection.request(method, params, options),
    hello: Effect.suspend(() => connection.info().closed ? Effect.fail(new RunnerError("CONNECTION_CLOSED", "Runner connection is closed")) : Effect.succeed(ready)),
    ping: (delayMs = 0) => connection.request("system.ping", { delayMs }).pipe(
      Effect.flatMap((value) => Effect.try({
        try: () => {
          if (typeof value !== "object" || value === null || !("ok" in value) || value.ok !== true) {
            throw new RunnerError("PROTOCOL_ERROR", "Invalid ping result");
          }
          return { ok: true as const };
        }, catch: asRunnerError,
      })),
    ),
    connectionInfo: Effect.sync(connection.info),
  };
}));

export function createRuntimeClientLayer(options: RunnerOptions = {}): Layer.Layer<RuntimeClient, RunnerError> {
  return RuntimeClientLive.pipe(Layer.provide(Layer.succeed(RunnerConfig, options)));
}
