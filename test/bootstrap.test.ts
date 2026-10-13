import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { Effect, Layer } from "effect";
import { createAgentKit } from "../src/bootstrap.js";
import { RuntimeClient } from "../src/client.js";
import type { RunnerOptions, RuntimeClientService } from "../src/client.js";
import { PROTOCOL_VERSION, RunnerError } from "../src/protocol.js";

async function application(t: TestContext, options: RunnerOptions = {}) {
  const app = await createAgentKit(options);
  t.after(() => app.close());
  return app;
}

const connectionInfo = Effect.gen(function* () { return yield* (yield* RuntimeClient).connectionInfo; });
const ping = (delayMs = 0) => Effect.gen(function* () { return yield* (yield* RuntimeClient).ping(delayMs); });
const request = (method: string) => Effect.gen(function* () { return yield* (yield* RuntimeClient).request(method); });

test("framework starts the real Go runner and closes its process through the Effect scope", async (t) => {
  const app = await application(t);
  assert.equal(app.hello.name, "agent-kit");
  assert.equal(app.hello.protocolVersion, PROTOCOL_VERSION);
  assert.deepEqual(await app.runtime.runPromise(ping()), { ok: true });
  const info = await app.runtime.runPromise(connectionInfo);
  assert.ok(info.pid);
  assert.equal(info.pendingRequests, 0);
  await app.close();
  await app.close();
  assert.throws(() => process.kill(info.pid!, 0), { code: "ESRCH" });
});

test("concurrent requests correlate results without requiring response order", async (t) => {
  const app = await application(t);
  const completion: number[] = [];
  const delays = [80, 0, 20, 5];
  await Promise.all(delays.map((delay, index) => app.runtime.runPromise(ping(delay)).then((result) => {
    assert.equal(result.ok, true);
    completion.push(index);
  })));
  assert.notEqual(completion[0], 0);
  assert.equal(completion.length, delays.length);
  assert.equal((await app.runtime.runPromise(connectionInfo)).pendingRequests, 0);
});

test("AbortSignal interruption waits for Go cancellation and preserves the shared connection", async (t) => {
  const app = await application(t);
  const controller = new AbortController();
  const waiting = app.runtime.runPromise(ping(60000), { signal: controller.signal });
  const observed = assert.rejects(waiting);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal((await app.runtime.runPromise(connectionInfo)).pendingRequests, 1);
  controller.abort();
  await observed;
  const info = await app.runtime.runPromise(connectionInfo);
  assert.equal(info.confirmedCancellations, 1);
  assert.equal(info.pendingRequests, 0);
  assert.equal(info.closed, false);
  assert.deepEqual(await app.runtime.runPromise(ping()), { ok: true });
});

test("request timeout also cancels the Go operation before returning", async (t) => {
  const app = await application(t, { requestTimeoutMs: 150 });
  await assert.rejects(app.runtime.runPromise(ping(60000)), { code: "TIMEOUT" });
  const info = await app.runtime.runPromise(connectionInfo);
  assert.equal(info.confirmedCancellations, 1);
  assert.equal(info.pendingRequests, 0);
  assert.deepEqual(await app.runtime.runPromise(ping()), { ok: true });
});

test("closing the application settles active requests and releases the runner", async (t) => {
  const app = await application(t);
  const info = await app.runtime.runPromise(connectionInfo);
  const outcome = assert.rejects(app.runtime.runPromise(ping(60000)));
  await new Promise((resolve) => setTimeout(resolve, 20));
  await app.close();
  await outcome;
  assert.throws(() => process.kill(info.pid!, 0), { code: "ESRCH" });
});

test("unknown method names fail without falling back", async (t) => {
  const app = await application(t);
  await assert.rejects(app.runtime.runPromise(request("command.exec")), { code: "UNKNOWN_METHOD" });
  assert.deepEqual(await app.runtime.runPromise(ping()), { ok: true });
});

test("the Go runner enforces concurrency limits while cancellation remains available", async (t) => {
  const app = await application(t, { args: ["--max-concurrent", "1"] });
  const controller = new AbortController();
  const outcome = assert.rejects(app.runtime.runPromise(ping(60000), { signal: controller.signal }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  await assert.rejects(app.runtime.runPromise(ping()), { code: "BUSY" });
  controller.abort();
  await outcome;
  assert.deepEqual(await app.runtime.runPromise(ping()), { ok: true });
});

test("a replacement Effect layer can supply the client and release its own resources", async () => {
  let released = 0;
  const hello = { name: "test-layer", protocolVersion: 1, methods: ["system.hello"] };
  const service: RuntimeClientService = {
    request: () => Effect.succeed({}), hello: Effect.succeed(hello), ping: () => Effect.succeed({ ok: true }),
    connectionInfo: Effect.succeed({ pid: undefined, pendingRequests: 0, closed: false, confirmedCancellations: 0 }),
  };
  const layer = Layer.effect(RuntimeClient, Effect.acquireRelease(
    Effect.succeed(service), () => Effect.sync(() => { released++; }),
  ));
  const app = await createAgentKit({}, layer);
  assert.equal(app.hello.name, "test-layer");
  await app.close();
  assert.equal(released, 1);
});

test("invalid configuration and missing runner fail startup", async () => {
  await assert.rejects(createAgentKit({ requestTimeoutMs: 0 }));
  await assert.rejects(createAgentKit({ runnerPath: "/missing/agent-kit-runner" }));
});

for (const mode of ["malformed", "oversized", "version", "exit", "hang"]) {
  test(`invalid runner (${mode}) fails startup and its scope is cleaned up`, async () => {
    await assert.rejects(createAgentKit({
      runnerPath: process.execPath,
      args: [fileURLToPath(new URL("./fixtures/bad-runner.mjs", import.meta.url)), mode],
      maxMessageBytes: 1024, requestTimeoutMs: 200, shutdownTimeoutMs: 200,
    }));
  });
}

test("outgoing messages are bounded and a rejected request leaves the connection usable", async (t) => {
  const app = await application(t, { maxMessageBytes: 1024 });
  const oversized = Effect.gen(function* () {
    const client = yield* RuntimeClient;
    return yield* client.request("system.ping", { extra: "x".repeat(2048) });
  });
  await assert.rejects(app.runtime.runPromise(oversized));
  assert.deepEqual(await app.runtime.runPromise(ping()), { ok: true });
});

test("typed protocol errors stay in the Effect error channel", async (t) => {
  const app = await application(t);
  const error = await app.runtime.runPromise(Effect.flip(request("unknown")));
  assert.ok(error instanceof RunnerError);
  assert.equal(error.code, "UNKNOWN_METHOD");
});
