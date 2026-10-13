import { Effect, Layer } from "effect";
import { RunnerError, RuntimeClient, base64Reply, booleanReply, decimalReply, decodeReply, recordReply, stringReply } from "../go-bridge/index.js";
import { FilesystemService } from "./service.js";
import type { FileType, FilesystemServiceApi } from "./service.js";

function fileType(value: unknown): FileType {
  if (value !== "file" && value !== "directory" && value !== "symlink" && value !== "other") throw new Error("Invalid file type");
  return value;
}

function mutationError(error: RunnerError): RunnerError {
  if (error.details !== undefined || !["PROTOCOL_ERROR", "CONNECTION_CLOSED", "TIMEOUT", "CANCELLATION_FAILED"].includes(error.code)) return error;
  return new RunnerError(error.code, error.message, error, { reason: "OUTCOME_UNKNOWN", mutationState: "may_have_changed" });
}

export const FilesystemLive = Layer.effect(FilesystemService, Effect.gen(function* () {
  const client = yield* RuntimeClient;
  const call = <A>(method: string, params: Parameters<typeof client.request>[1], decode: (value: unknown) => A) =>
    client.request(method, params).pipe(Effect.flatMap((value) => decodeReply(value, decode)));
  return {
    read: (request) => call("filesystem.read", { ...request }, (value) => ({ data: base64Reply(recordReply(value).data, 524288) })),
    write: ({ data, ...request }) => {
      if (data.byteLength > 524288) return Effect.fail(new RunnerError("RESOURCE_EXHAUSTED", "File write limit is 512 KiB", undefined, { reason: "LIMIT_EXCEEDED", mutationState: "not_started" }));
      return call("filesystem.write", { ...request, data: Buffer.from(data).toString("base64") }, (value) => {
        const bytesWritten = decimalReply(recordReply(value).bytesWritten);
        if (BigInt(bytesWritten) !== BigInt(data.byteLength)) throw new Error("Incorrect write byte count");
        return { bytesWritten };
      }).pipe(Effect.mapError(mutationError));
    },
    readDir: (request) => call("filesystem.readDir", { ...request }, (value) => {
      const entries = recordReply(value).entries;
      if (!Array.isArray(entries) || entries.length > 10000) throw new Error("Invalid directory entries");
      return { entries: entries.map((value) => {
        const entry = recordReply(value);
        return { name: stringReply(entry.name), type: fileType(entry.type) };
      }) };
    }),
    stat: (request) => call("filesystem.stat", { ...request }, (value) => {
      const info = recordReply(value);
      const modifiedAt = stringReply(info.modifiedAt);
      if (!Number.isFinite(Date.parse(modifiedAt))) throw new Error("Invalid modification time");
      return { type: fileType(info.type), size: decimalReply(info.size), modifiedAt };
    }),
    mkdir: (request) => call("filesystem.mkdir", { ...request }, (value) => {
      if (!booleanReply(recordReply(value).created)) throw new Error("Directory creation not confirmed");
      return { created: true as const };
    }).pipe(Effect.mapError(mutationError)),
  } satisfies FilesystemServiceApi;
}));
