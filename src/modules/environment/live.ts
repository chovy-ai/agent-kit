import { Effect, Layer } from "effect";
import { RuntimeClient, decodeReply, recordReply } from "../go-bridge/index.js";
import { EnvironmentService } from "./service.js";

export const EnvironmentLive = Layer.effect(EnvironmentService, Effect.gen(function* () {
  const client = yield* RuntimeClient;
  return {
    list: () => client.request("environment.list").pipe(Effect.flatMap((value) => decodeReply(value, (value) => {
      const ids = recordReply(value).environments;
      if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string" && id.length > 0) || new Set(ids).size !== ids.length) {
        throw new Error("Invalid environment IDs");
      }
      return { environments: [...ids] as string[] };
    }))),
  };
}));
