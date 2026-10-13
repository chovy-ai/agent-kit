import type { Effect, ManagedRuntime } from "effect";
import type { RunnerError } from "../modules/go-bridge/index.js";

export type ToolRuntime<R> = Pick<ManagedRuntime.ManagedRuntime<R, RunnerError>, "runPromise">;

export function runTool<A, R>(runtime: ToolRuntime<R>, effect: Effect.Effect<A, RunnerError, R>, signal?: AbortSignal): Promise<A> {
  return runtime.runPromise(effect, signal === undefined ? undefined : { signal });
}
