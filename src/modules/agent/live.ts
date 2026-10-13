import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentSession, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Effect, Layer } from "effect";
import { RunnerError, RuntimeClient } from "../go-bridge/index.js";
import { AgentService, AgentSessionFactory } from "./service.js";
import type { AgentSessionFactoryApi, AgentSessionOptions, AgentSessionResult } from "./service.js";

export const AgentSessionFactoryLive = Layer.succeed(AgentSessionFactory, { create: createAgentSession });

class SessionOwner {
  private closed = false;
  private closing: Promise<void> | undefined;
  private readonly sessions = new Set<AgentSession>();
  private readonly pending = new Set<Promise<AgentSessionResult>>();
  private readonly releasing = new Map<AgentSession, Promise<void>>();
  private readonly retired = new WeakSet<AgentSession>();
  private readonly cleanupErrors: unknown[] = [];

  constructor(private readonly factory: AgentSessionFactoryApi) {}

  create(options: AgentSessionOptions, tools: ToolDefinition[], signal: AbortSignal): Promise<AgentSessionResult> {
    if (this.closed) return Promise.reject(new RunnerError("APPLICATION_CLOSED", "Agent application is closing"));
    if (signal.aborted) return Promise.reject(new RunnerError("CANCELLED", "Session creation was cancelled"));
    const pending = this.open(options, tools, signal);
    this.pending.add(pending);
    void pending.then(() => this.pending.delete(pending), () => this.pending.delete(pending));
    return pending;
  }

  private async open(options: AgentSessionOptions, tools: ToolDefinition[], signal: AbortSignal): Promise<AgentSessionResult> {
    const result = await this.factory.create({
      ...options, sessionManager: options.sessionManager ?? SessionManager.inMemory(options.cwd),
      customTools: tools, tools: tools.map((tool) => tool.name),
    }, signal);
    this.sessions.add(result.session);
    if (this.closed || signal.aborted) {
      await this.release(result.session);
      throw new RunnerError(this.closed ? "APPLICATION_CLOSED" : "CANCELLED", "Session creation ended after cancellation or shutdown");
    }
    return result;
  }

  release(session: AgentSession): Promise<void> {
    const existing = this.releasing.get(session);
    if (existing) return existing;
    if (this.retired.has(session)) return Promise.resolve();
    if (!this.sessions.has(session)) return Promise.reject(new RunnerError("NOT_FOUND", "Session is not owned by this application"));
    const releasing = (async () => {
      try { await session.abort(); }
      finally {
        try { session.dispose(); }
        finally { this.sessions.delete(session); this.retired.add(session); }
      }
    })();
    this.releasing.set(session, releasing);
    void releasing.then(() => this.releasing.delete(session), (error) => {
      this.releasing.delete(session);
      this.cleanupErrors.push(error);
    });
    return releasing;
  }

  close(): Promise<void> {
    this.closed = true;
    return this.closing ??= (async () => {
      // Pi's async factory has no cancellation API. Late sessions remain owned
      // and are disposed before the bridge dependency can be released.
      await Promise.allSettled([...this.pending]);
      await Promise.allSettled([...this.sessions].map((session) => this.release(session)));
      if (this.cleanupErrors.length) throw new AggregateError(this.cleanupErrors, "Agent sessions did not close cleanly");
    })();
  }
}

function sessionError(error: unknown): RunnerError {
  return error instanceof RunnerError ? error : new RunnerError("AGENT_ERROR", error instanceof Error ? error.message : String(error), error);
}

export const AgentLive = Layer.effect(AgentService, Effect.gen(function* () {
  const bridge = yield* RuntimeClient;
  yield* bridge.hello;
  const factory = yield* AgentSessionFactory;
  const owner = yield* Effect.acquireRelease(Effect.sync(() => new SessionOwner(factory)), (owner) => Effect.promise(() => owner.close()));
  return {
    createSession: (options: AgentSessionOptions, tools: ToolDefinition[]) => Effect.tryPromise({ try: (signal) => owner.create(options, tools, signal), catch: sessionError }),
    closeSession: (session: AgentSession) => Effect.tryPromise({ try: () => owner.release(session), catch: sessionError }),
  };
}));
