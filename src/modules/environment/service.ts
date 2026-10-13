import { Context } from "effect";
import type { Effect } from "effect";
import type { RunnerError } from "../go-bridge/index.js";

export interface EnvironmentRef { environmentId: string; }
export interface EnvironmentList { environments: string[]; }
export interface EnvironmentServiceApi {
  list(): Effect.Effect<EnvironmentList, RunnerError>;
}

export class EnvironmentService extends Context.Service<EnvironmentService, EnvironmentServiceApi>()("agent-kit/EnvironmentService") {}
