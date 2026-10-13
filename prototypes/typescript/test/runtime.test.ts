import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_TIMEOUT_MS, Runtime, RuntimeError } from "../src/index.js";
import { MemoryTestEnvironment } from "./fixtures/memory-environment.js";

test("unknown environments never fall back to a registered adapter", async () => {
  const remote = new MemoryTestEnvironment();
  const runtime = new Runtime([remote]);
  const isUnknown = (error: unknown) => error instanceof RuntimeError && error.code === "UNKNOWN_ENVIRONMENT";
  await assert.rejects(runtime.exec("missing", { command: "touch marker" }), isUnknown);
  await assert.rejects(runtime.readFile("missing", "file"), isUnknown);
  await assert.rejects(runtime.writeFile("missing", "file", "data"), isUnknown);
  await assert.rejects(runtime.listDirectory("missing"), isUnknown);
  await assert.rejects(runtime.stat("missing", "file"), isUnknown);
  await assert.rejects(runtime.mkdir("missing", "dir"), isUnknown);
  assert.equal(remote.requests.length, 0);
  assert.equal(remote.fileCalls.length, 0);
});

test("duplicate environment IDs are rejected and descriptor listings are copies", () => {
  const remote = new MemoryTestEnvironment();
  const runtime = new Runtime([remote]);
  assert.throws(() => runtime.register(remote), { code: "DUPLICATE_ENVIRONMENT" });
  runtime.listEnvironments()[0]!.cwd = "/changed";
  assert.equal(runtime.listEnvironments()[0]!.cwd, "/remote-workspace");
});

test("custom command adapters receive defaults, overrides, signal and streaming callbacks", async () => {
  const remote = new MemoryTestEnvironment();
  const runtime = new Runtime([remote]);
  const controller = new AbortController();
  let streamed = "";
  await runtime.exec("remote-test", {
    command: "remote-only-command", cwd: "/remote/path", env: { TASK: "remote" }, signal: controller.signal,
    onOutput: ({ data }) => { streamed += data; },
  });
  const request = remote.requests[0]!;
  assert.equal(request.timeoutMs, DEFAULT_TIMEOUT_MS);
  assert.equal(request.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES);
  assert.equal(request.cwd, "/remote/path");
  assert.deepEqual(request.env, { TASK: "remote" });
  assert.equal(request.signal, controller.signal);
  assert.equal(streamed, "from remote test adapter");
  await runtime.exec("remote-test", { command: "second", timeoutMs: 500, maxOutputBytes: 50 });
  assert.equal(remote.requests[1]!.timeoutMs, 500);
  assert.equal(remote.requests[1]!.maxOutputBytes, 50);
});

test("filesystem requests preserve remote paths and forward read ranges and cancellation", async () => {
  const remote = new MemoryTestEnvironment();
  const runtime = new Runtime([remote]);
  const signal = new AbortController().signal;
  await runtime.writeFile("remote-test", "/remote-workspace/file", "remote bytes", { signal });
  const bytes = await runtime.readFile("remote-test", "/remote-workspace/file", { offset: 7, length: 5, signal });
  assert.equal(new TextDecoder().decode(bytes), "bytes");
  assert.equal(remote.fileCalls[1]!.path, "/remote-workspace/file");
  assert.equal(remote.fileCalls[1]!.options.signal, signal);
  assert.equal((await runtime.stat("remote-test", "file")).size, 12);
  assert.deepEqual(await runtime.listDirectory("remote-test"), [{ name: "file", type: "file" }]);
  await runtime.mkdir("remote-test", "dir");
  await runtime.writeFile("remote-test", "dir/file", new Uint8Array([1, 2]));
  assert.equal(remote.data.size, 2);
});

test("pre-cancellation prevents remote requests from being dispatched", async () => {
  const remote = new MemoryTestEnvironment();
  const runtime = new Runtime([remote]);
  const signal = AbortSignal.abort();
  await assert.rejects(runtime.exec("remote-test", { command: "remote", signal }), { code: "CANCELLED" });
  await assert.rejects(runtime.readFile("remote-test", "file", { signal }), { code: "CANCELLED" });
  assert.equal(remote.requests.length + remote.fileCalls.length, 0);
});

test("adapter connection failures stay errors and are never retried on another environment", async () => {
  const remote = new MemoryTestEnvironment();
  let calls = 0;
  remote.exec = async () => { calls++; throw new Error("Remote disconnected"); };
  const runtime = new Runtime([remote]);
  await assert.rejects(runtime.exec("remote-test", { command: "anything" }), { code: "ADAPTER_ERROR", message: "Remote disconnected" });
  assert.equal(calls, 1);
});
