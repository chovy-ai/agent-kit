import { Effect, Layer } from "effect";
import { RunnerError, RuntimeClient, base64Reply, booleanReply, decodeReply, integerReply, recordReply, stringReply } from "../go-bridge/index.js";
import type { JsonObject } from "../go-bridge/index.js";
import { ProcessService } from "./service.js";
import type { ExecResult, ProcessServiceApi } from "./service.js";

function executionResult(value: unknown): ExecResult {
  const reply = recordReply(value);
  const completion = reply.completion;
  if (completion !== "not_started" && completion !== "finished" && completion !== "unconfirmed") throw new Error("Invalid process completion");
  const exitCode = reply.exitCode === null ? null : integerReply(reply.exitCode);
  const durationMs = integerReply(reply.durationMs);
  if (durationMs < 0) throw new Error("Invalid process duration");
  const stdout = base64Reply(reply.stdout, 8388608);
  const stderr = base64Reply(reply.stderr, 8388608);
  if (stdout.byteLength + stderr.byteLength > 8388608) throw new Error("Combined output exceeds its limit");
  const result: ExecResult = {
    completion, exitCode, durationMs, stdout, stderr,
    signal: stringReply(reply.signal), outputTruncated: booleanReply(reply.outputTruncated), outputIncomplete: booleanReply(reply.outputIncomplete),
  };
  if (reply.executionError !== undefined) {
    const error = recordReply(reply.executionError);
    result.executionError = { code: stringReply(error.code), message: stringReply(error.message) };
    if (error.details !== undefined) result.executionError.details = recordReply(error.details) as JsonObject;
  }
  return result;
}

export const ProcessLive = Layer.effect(ProcessService, Effect.gen(function* () {
  const client = yield* RuntimeClient;
  return {
    exec: (request, onOutput) => client.request("process.exec", { ...request }, onOutput === undefined ? {} : {
      onOutput: (event) => onOutput({ stream: event.stream, data: base64Reply(event.data, 65536) }),
    }).pipe(Effect.flatMap((value) => decodeReply(value, executionResult)), Effect.mapError((error) =>
      error.code === "PROTOCOL_ERROR" ? new RunnerError(error.code, error.message, error, { completion: "unconfirmed", reason: "INVALID_TERMINAL" }) : error)),
  } satisfies ProcessServiceApi;
}));
