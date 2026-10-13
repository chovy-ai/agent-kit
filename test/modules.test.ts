import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Effect, Layer, ManagedRuntime } from "effect";
import { createAgentKit, createPiAgent } from "../src/bootstrap.js";
import { createFrameworkTools } from "../src/pi.js";
import { AgentSessionFactory } from "../src/modules/agent/index.js";
import type { AgentSessionResult } from "../src/modules/agent/index.js";
import { EnvironmentService } from "../src/modules/environment/index.js";
import { FilesystemService } from "../src/modules/filesystem/index.js";
import type { FilesystemServiceApi } from "../src/modules/filesystem/index.js";
import { ProcessService } from "../src/modules/process/index.js";
import { RuntimeClient, RunnerError } from "../src/modules/go-bridge/index.js";
import type { RuntimeClientService } from "../src/modules/go-bridge/index.js";
import { TOOL_DISPLAY_BYTES } from "../src/tooling/index.js";

const methods = ["system.hello", "environment.list", "filesystem.read", "filesystem.write", "filesystem.readDir", "filesystem.stat", "filesystem.mkdir", "process.exec"];
function bridge(request: RuntimeClientService["request"], events?: string[]) {
  return Layer.effect(RuntimeClient, Effect.acquireRelease(Effect.sync(() => {
    events?.push("bridge acquired");
    return {
      request, hello: Effect.succeed({ name: "fake", protocolVersion: 1, methods }), ping: () => Effect.succeed({ ok: true as const }),
      connectionInfo: Effect.succeed({ pid: undefined, pendingRequests: 0, closed: false, confirmedCancellations: 0 }),
    };
  }), () => Effect.sync(() => { events?.push("bridge closed"); })));
}
const unusedRequest: RuntimeClientService["request"] = () => Effect.fail(new RunnerError("UNEXPECTED_RPC", "RPC should not be used"));
function fakeSession(events: string[]): AgentSessionResult {
  return { session: { abort: async () => { events.push("Pi aborted"); }, dispose: () => { events.push("Pi disposed"); } } } as unknown as AgentSessionResult;
}

test("typed capability services share one real Go runner and preserve host bytes", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-kit-modules-"));
  const app = await createAgentKit({ args: ["--cwd", cwd] });
  t.after(async () => { await app.close(); await rm(cwd, { recursive: true, force: true }); });
  const result = await app.runtime.runPromise(Effect.gen(function* () {
    const client = yield* RuntimeClient;
    const environment = yield* EnvironmentService;
    const filesystem = yield* FilesystemService;
    const process = yield* ProcessService;
    const before = yield* client.connectionInfo;
    assert.deepEqual(yield* environment.list(), { environments: ["local"] });
    yield* filesystem.mkdir({ environmentId: "local", path: "data", recursive: true });
    const data = new Uint8Array([0, 255, 42]);
    assert.deepEqual(yield* filesystem.write({ environmentId: "local", path: "data/file", data }), { bytesWritten: "3" });
    assert.deepEqual([...((yield* filesystem.read({ environmentId: "local", path: "data/file" })).data)], [...data]);
    assert.equal((yield* filesystem.stat({ environmentId: "local", path: "data/file" })).size, "3");
    assert.deepEqual(yield* filesystem.readDir({ environmentId: "local", path: "data" }), { entries: [{ name: "file", type: "file" }] });
    const output: number[] = [];
    const exec = yield* process.exec({ environmentId: "local", command: "cat data/file" }, ({ data }) => output.push(...data));
    assert.deepEqual([...exec.stdout], [0, 255, 42]);
    assert.deepEqual(output, [0, 255, 42]);
    assert.equal(exec.completion, "finished");
    const after = yield* client.connectionInfo;
    assert.equal(before.pid, after.pid);
    assert.equal(after.pendingRequests, 0);
    return before;
  }));
  assert.ok(result.pid);
  await app.close();
  assert.throws(() => process.kill(result.pid!, 0), { code: "ESRCH" });
});

test("a filesystem replacement supplies tools through its service and acquires the bridge once", async () => {
  const events: string[] = [];
  let written = "";
  const filesystem: FilesystemServiceApi = {
    read: () => Effect.succeed({ data: new TextEncoder().encode("replacement") }),
    write: ({ data, environmentId, path }) => Effect.sync(() => { written = `${environmentId}:${path}:${new TextDecoder().decode(data)}`; return { bytesWritten: String(data.byteLength) }; }),
    readDir: () => Effect.succeed({ entries: [] }), stat: () => Effect.succeed({ type: "file", size: "0", modifiedAt: "2026-10-13T00:00:00Z" }),
    mkdir: () => Effect.succeed({ created: true }),
  };
  const app = await createAgentKit({}, bridge(unusedRequest, events), { filesystem: Layer.succeed(FilesystemService, filesystem) });
  try {
    const read = await app.tools.find((tool) => tool.name === "filesystem_read")!.execute("read", { environmentId: "custom", path: "virtual" }, undefined, undefined, {} as never);
    assert.equal(read.content[0]?.type === "text" && read.content[0].text, "replacement");
    const write = await app.tools.find((tool) => tool.name === "filesystem_write")!.execute("write", { environmentId: "custom", path: "virtual", content: "data" }, undefined, undefined, {} as never);
    assert.equal(write.isError, false);
    assert.equal(written, "custom:virtual:data");
    assert.deepEqual(events, ["bridge acquired"]);
  } finally { await app.close(); }
  assert.deepEqual(events, ["bridge acquired", "bridge closed"]);
});

test("capability decoders reject invalid replies while preserving uncertain side effects", async () => {
  const calls: string[] = [];
  const app = await createAgentKit({}, bridge((method) => {
    calls.push(method);
    return Effect.succeed(method === "environment.list" ? { environments: ["duplicate", "duplicate"] }
      : method === "filesystem.read" ? { data: "invalid!" }
      : method === "filesystem.write" ? { bytesWritten: "0" }
      : { completion: "finished", exitCode: "wrong" });
  }));
  try {
    await assert.rejects(app.runtime.runPromise(Effect.gen(function* () { return yield* (yield* EnvironmentService).list(); })), { code: "PROTOCOL_ERROR" });
    await assert.rejects(app.runtime.runPromise(Effect.gen(function* () { return yield* (yield* FilesystemService).read({ environmentId: "custom", path: "virtual" }); })), { code: "PROTOCOL_ERROR" });
    await assert.rejects(app.runtime.runPromise(Effect.gen(function* () { return yield* (yield* FilesystemService).write({ environmentId: "custom", path: "virtual", data: new Uint8Array([1]) }); })), { code: "PROTOCOL_ERROR", details: { reason: "OUTCOME_UNKNOWN", mutationState: "may_have_changed" } });
    await assert.rejects(app.runtime.runPromise(Effect.gen(function* () { return yield* (yield* ProcessService).exec({ environmentId: "custom", command: "action" }); })), { code: "PROTOCOL_ERROR", details: { completion: "unconfirmed", reason: "INVALID_TERMINAL" } });
    assert.deepEqual(calls, ["environment.list", "filesystem.read", "filesystem.write", "process.exec"]);
  } finally { await app.close(); }
});

test("legacy bridge-only tool construction still borrows the existing connection", async () => {
  const events: string[] = [];
  const runtime = ManagedRuntime.make(bridge(() => Effect.succeed({ environments: ["legacy"] }), events));
  try {
    const tools = createFrameworkTools(runtime, methods);
    const result = await tools.find((tool) => tool.name === "environment_list")!.execute("list", {}, undefined, undefined, {} as never);
    assert.equal(result.isError, false);
    assert.equal(result.content[0]?.type === "text" && result.content[0].text, '{"environments":["legacy"]}');
    assert.deepEqual(events, ["bridge acquired"]);
  } finally { await runtime.dispose(); }
  assert.deepEqual(events, ["bridge acquired", "bridge closed"]);
});

test("typed filesystem writes enforce their byte limit before encoding or issuing RPC", async () => {
  let calls = 0;
  const app = await createAgentKit({}, bridge(() => { calls++; return Effect.succeed({ bytesWritten: "0" }); }));
  try {
    await assert.rejects(app.runtime.runPromise(Effect.gen(function* () {
      return yield* (yield* FilesystemService).write({ environmentId: "custom", path: "virtual", data: new Uint8Array(524289) });
    })), { code: "RESOURCE_EXHAUSTED", details: { reason: "LIMIT_EXCEEDED", mutationState: "not_started" } });
    assert.equal(calls, 0);
  } finally { await app.close(); }
});

test("Pi startup fixes the tool allowlist and disposes the session before the bridge", async () => {
  const events: string[] = [];
  const created = fakeSession(events);
  const app = await createPiAgent({}, bridge(unusedRequest, events), { sessionFactory: Layer.succeed(AgentSessionFactory, {
    create: async (options) => {
      events.push("Pi created");
      assert.deepEqual(options.tools, options.customTools?.map((tool) => tool.name));
      assert.ok(options.tools?.includes("process_exec"));
      return created;
    },
  }) });
  assert.equal(app.session, created.session);
  await app.close();
  await app.close();
  await assert.rejects(app.createSession(), { code: "APPLICATION_CLOSED" });
  assert.deepEqual(events, ["bridge acquired", "Pi created", "Pi aborted", "Pi disposed", "bridge closed"]);
});

test("a failed capability layer releases its acquired bridge", async () => {
  const events: string[] = [];
  const filesystem = Layer.effect(FilesystemService, Effect.fail(new RunnerError("TEST_INIT_FAILED", "Capability initialization failed")));
  await assert.rejects(createAgentKit({}, bridge(unusedRequest, events), { filesystem }), { code: "TEST_INIT_FAILED" });
  assert.deepEqual(events, ["bridge acquired", "bridge closed"]);
});

test("session cleanup failure is reported while remaining sessions and bridge are still released", async () => {
  const events: string[] = [];
  let calls = 0;
  const app = await createAgentKit({}, bridge(unusedRequest, events), { sessionFactory: Layer.succeed(AgentSessionFactory, {
    create: async () => calls++ === 0 ? ({ session: {
      abort: async () => { events.push("failed abort"); throw new Error("Abort failed"); },
      dispose: () => { events.push("failed session disposed"); },
    } } as unknown as AgentSessionResult) : fakeSession(events),
  }) });
  await app.createSession();
  await app.createSession();
  await assert.rejects(app.close());
  assert.ok(events.includes("failed session disposed"));
  assert.ok(events.includes("Pi disposed"));
  assert.equal(events.at(-1), "bridge closed");
});

test("cancelling session creation disposes the late session while preserving the shared application", async () => {
  const events: string[] = [];
  let resolve: (session: AgentSessionResult) => void = () => {};
  let markStarted: () => void = () => {};
  const started = new Promise<void>((done) => { markStarted = done; });
  const deferred = new Promise<AgentSessionResult>((done) => { resolve = done; });
  const app = await createAgentKit({}, bridge(unusedRequest, events), { sessionFactory: Layer.succeed(AgentSessionFactory, {
    create: async () => { markStarted(); return deferred; },
  }) });
  const controller = new AbortController();
  const observed = assert.rejects(app.createSession({}, controller.signal));
  await started;
  controller.abort();
  await observed;
  resolve(fakeSession(events));
  await new Promise((done) => setTimeout(done, 10));
  assert.deepEqual(events, ["bridge acquired", "Pi aborted", "Pi disposed"]);
  await app.close();
  assert.equal(events.at(-1), "bridge closed");
});

test("a failed Pi session startup releases the real Go process", async () => {
  let pid: number | undefined;
  const sessionFactory = Layer.effect(AgentSessionFactory, Effect.gen(function* () {
    pid = (yield* (yield* RuntimeClient).connectionInfo).pid;
    return { create: async () => { throw new Error("Model initialization failed"); } };
  }));
  await assert.rejects(createPiAgent({}, undefined, { sessionFactory }), { code: "AGENT_ERROR" });
  assert.ok(pid);
  assert.throws(() => process.kill(pid!, 0), { code: "ESRCH" });
});

test("shutdown owns and disposes a session that finishes creating late", async () => {
  const events: string[] = [];
  let resolve: (session: AgentSessionResult) => void = () => {};
  let markStarted: () => void = () => {};
  const started = new Promise<void>((done) => { markStarted = done; });
  const deferred = new Promise<AgentSessionResult>((done) => { resolve = done; });
  const app = await createAgentKit({}, bridge(unusedRequest, events), { sessionFactory: Layer.succeed(AgentSessionFactory, {
    create: async () => { markStarted(); return deferred; },
  }) });
  const creation = assert.rejects(app.createSession());
  await started;
  let closed = false;
  const closing = app.close().then(() => { closed = true; });
  await new Promise((done) => setTimeout(done, 10));
  assert.equal(closed, false);
  assert.deepEqual(events, ["bridge acquired"]);
  resolve(fakeSession(events));
  await Promise.all([creation, closing]);
  assert.deepEqual(events, ["bridge acquired", "Pi aborted", "Pi disposed", "bridge closed"]);
});

test("file and command tools bound UTF-8 displays without losing continuation or completion", async (t) => {
  const app = await createAgentKit();
  t.after(() => app.close());
  const cwd = await mkdtemp(join(tmpdir(), "agent-kit-display-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const file = join(cwd, "large.txt");
  await app.runtime.runPromise(Effect.gen(function* () { return yield* (yield* FilesystemService).write({ environmentId: "local", path: file, data: new TextEncoder().encode("汉字".repeat(6000)) }); }));
  const read = await app.tools.find((tool) => tool.name === "filesystem_read")!.execute("read", { environmentId: "local", path: file }, undefined, undefined, {} as never);
  assert.equal(read.isError, false);
  assert.ok(read.content[0]?.type === "text");
  assert.ok(Buffer.byteLength(read.content[0].text) <= TOOL_DISPLAY_BYTES);
  const details = read.details as { displayTruncated: boolean; nextOffset: string };
  assert.equal(details.displayTruncated, true);
  assert.ok(read.content[0].text.includes(`offset=${details.nextOffset}`));
  const continuation = await app.tools.find((tool) => tool.name === "filesystem_read")!.execute("next", { environmentId: "local", path: file, offset: details.nextOffset }, undefined, undefined, {} as never);
  assert.equal(continuation.isError, false);
  const exec = await app.tools.find((tool) => tool.name === "process_exec")!.execute("exec", { environmentId: "local", command: "printf '%40000s' '' | tr ' ' '\\001'", maxOutputBytes: 65536 }, undefined, undefined, {} as never);
  assert.equal(exec.isError, false);
  assert.ok(exec.content[0]?.type === "text");
  assert.ok(Buffer.byteLength(exec.content[0].text) <= TOOL_DISPLAY_BYTES);
  const result = JSON.parse(exec.content[0].text) as { completion: string; exitCode: number; outputTruncated: boolean; displayTruncated: boolean };
  assert.equal(result.completion, "finished");
  assert.equal(result.exitCode, 0);
  assert.equal(result.outputTruncated, false);
  assert.equal(result.displayTruncated, true);
});
