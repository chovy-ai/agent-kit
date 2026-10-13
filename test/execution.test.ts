import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Effect } from "effect";
import { createAgentKit } from "../src/bootstrap.js";
import { RuntimeClient } from "../src/client.js";
import type { JsonObject } from "../src/protocol.js";

test("Pi-compatible stdio bridges a real remote server, files, streaming output and cancellation", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-kit-remote-"));
  const server = spawn(join(process.cwd(), ".build/remote-server"), ["--listen", "127.0.0.1:0", "--cwd", cwd], { stdio: ["ignore", "ignore", "pipe"] });
  t.after(async () => { server.kill("SIGTERM"); if (server.exitCode === null) await once(server, "exit"); await rm(cwd, { recursive: true, force: true }); });
  const endpoint = await new Promise<string>((resolve, reject) => {
    let logs = ""; const timer = setTimeout(() => reject(new Error("Server startup timeout")), 5000);
    server.on("error", reject); server.once("exit", () => reject(new Error(logs)));
    server.stderr.on("data", (chunk: Buffer) => { logs += chunk.toString(); const match = /remote endpoint: (ws:\/\/[^\s]+)/.exec(logs); if (match) { clearTimeout(timer); resolve(match[1]!); } });
  });
  const app = await createAgentKit({ args: ["--remote-endpoint", endpoint] });
  t.after(() => app.close());
  const call = (method: string, params: JsonObject, options = {}) => app.runtime.runPromise(Effect.gen(function* () { return yield* (yield* RuntimeClient).request(method, params, options); }));
  assert.deepEqual(await call("environment.list", {}), { environments: ["local", "remote"] });
  const data = Buffer.from("from remote file\n").toString("base64");
  await call("filesystem.write", { environmentId: "remote", path: "input.txt", data });
  await assert.rejects(call("filesystem.write", { environmentId: "remote", path: "missing/child", data }), { code: "NOT_FOUND", details: { reason: "PATH_NOT_FOUND", mutationState: "not_started" } });
  const writeTool = app.tools.find((tool) => tool.name === "filesystem_write")!;
  const failure = await writeTool.execute("missing", { environmentId: "remote", path: "missing/child", content: "text" }, undefined, undefined, {} as never);
  assert.equal(failure.isError, true);
  assert.ok(failure.content[0]?.type === "text");
  assert.deepEqual(JSON.parse(failure.content[0].text).details, { reason: "PATH_NOT_FOUND", mutationState: "not_started" });
  assert.deepEqual(await call("filesystem.read", { environmentId: "remote", path: "input.txt" }), { data });
  const progress: string[] = [];
  const result = await call("process.exec", { environmentId: "remote", command: "cat input.txt; sleep 0.1; printf stderr >&2" }, { onOutput: (event: { stream: string; data: string }) => { progress.push(Buffer.from(event.data, "base64").toString()); } }) as { stdout: string; stderr: string; exitCode: number };
  assert.equal(Buffer.from(result.stdout, "base64").toString(), "from remote file\n");
  assert.equal(Buffer.from(result.stderr, "base64").toString(), "stderr");
  assert.equal(result.exitCode, 0); assert.ok(progress.length >= 2);
  const controller = new AbortController();
  const running = app.runtime.runPromise(Effect.gen(function* () { return yield* (yield* RuntimeClient).request("process.exec", { environmentId: "remote", command: "printf started; sleep 30 & wait" }); }), { signal: controller.signal });
  const rejected = assert.rejects(running); await new Promise((resolve) => setTimeout(resolve, 100)); controller.abort(); await rejected;
  const after = await call("process.exec", { environmentId: "remote", command: "printf still-connected" }) as { stdout: string };
  assert.equal(Buffer.from(after.stdout, "base64").toString(), "still-connected");
  await assert.rejects(call("filesystem.write", { environmentId: "unknown", path: "file", data }), { code: "NOT_FOUND" });
});

test("output callback failure cleans its command and preserves the runner", async (t) => {
  const app = await createAgentKit(); t.after(() => app.close());
  await assert.rejects(app.runtime.runPromise(Effect.gen(function* () { return yield* (yield* RuntimeClient).request("process.exec", { environmentId: "local", command: "printf ready; sleep 30" }, { onOutput: () => { throw new Error("consumer failed"); } }); })), { code: "OUTPUT_FAILED" });
  assert.deepEqual(await app.runtime.runPromise(Effect.gen(function* () { return yield* (yield* RuntimeClient).ping(); })), { ok: true });
});
