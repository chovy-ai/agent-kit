import assert from "node:assert/strict";
import { access, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { LocalEnvironment, Runtime, RuntimeError } from "../src/index.js";

async function fixture(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), "agent runtime test "));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const local = new LocalEnvironment({ id: "local", cwd });
  return { cwd, local, runtime: new Runtime([local]) };
}

function quote(value: string) { return `'${value.replaceAll("'", "'\\''")}'`; }
function nodeCommand(source: string) { return `${quote(process.execPath)} -e ${quote(source)}`; }
function hasCode(code: string) {
  return (error: unknown) => error instanceof RuntimeError && error.code === code;
}

test("filesystem supports nested directories, binary data, byte ranges and metadata", async (t) => {
  const { runtime, cwd } = await fixture(t);
  await runtime.mkdir("local", "a/b", { recursive: true });
  const bytes = new Uint8Array([0, 1, 2, 255, 128]);
  await runtime.writeFile("local", "a/b/data.bin", bytes);
  assert.deepEqual([...await runtime.readFile("local", "a/b/data.bin")], [...bytes]);
  assert.deepEqual([...await runtime.readFile("local", "a/b/data.bin", { offset: 1, length: 2 })], [1, 2]);
  assert.deepEqual([...await runtime.readFile("local", "a/b/data.bin", { offset: 3 })], [255, 128]);
  assert.equal((await runtime.readFile("local", "a/b/data.bin", { offset: 100, length: 4 })).length, 0);
  assert.deepEqual(await runtime.listDirectory("local", "a/b"), [{ name: "data.bin", type: "file" }]);
  const stat = await runtime.stat("local", "a/b/data.bin");
  assert.equal(stat.size, 5);
  assert.equal(stat.type, "file");
  assert.ok(Number.isFinite(Date.parse(stat.modifiedAt)));
  await symlink(join(cwd, "a/b/data.bin"), join(cwd, "link"));
  assert.equal((await runtime.stat("local", "link")).type, "symlink");
});

test("files written through the SDK are visible to commands and vice versa", async (t) => {
  const { runtime } = await fixture(t);
  await runtime.writeFile("local", "input.txt", "来自 SDK\n");
  const result = await runtime.exec("local", { command: "cat input.txt > output.txt" });
  assert.equal(result.exitCode, 0);
  assert.equal(new TextDecoder().decode(await runtime.readFile("local", "output.txt")), "来自 SDK\n");
});

test("identical paths in two environments remain separate for both files and commands", async (t) => {
  const first = await fixture(t);
  const second = await fixture(t);
  const runtime = new Runtime([
    new LocalEnvironment({ id: "first", cwd: first.cwd }),
    new LocalEnvironment({ id: "second", cwd: second.cwd }),
  ]);
  await Promise.all([
    runtime.writeFile("first", "same.txt", "first"),
    runtime.writeFile("second", "same.txt", "second"),
  ]);
  const [a, b] = await Promise.all([
    runtime.exec("first", { command: "cat same.txt" }),
    runtime.exec("second", { command: "cat same.txt" }),
  ]);
  assert.equal(a.stdout, "first");
  assert.equal(b.stdout, "second");
});

test("cwd and environment variables work without persisting shell state", async (t) => {
  const { runtime, cwd } = await fixture(t);
  await runtime.mkdir("local", "sub dir");
  await runtime.writeFile("local", "sub dir/file", "subdir");
  const command = nodeCommand("process.stdout.write(process.env.TASK_VALUE + require('node:fs').readFileSync('file', 'utf8'))");
  const result = await runtime.exec("local", { command, cwd: "sub dir", env: { TASK_VALUE: "a'\n$(literal):" } });
  assert.equal(result.stdout, "a'\n$(literal):subdir");
  await runtime.exec("local", { command: "cd 'sub dir'" });
  const next = await runtime.exec("local", { command: nodeCommand("process.stdout.write(process.cwd())") });
  assert.equal(next.stdout, await realpath(cwd));
});

test("exit code and stdout/stderr remain distinct", async (t) => {
  const { runtime } = await fixture(t);
  const result = await runtime.exec("local", { command: nodeCommand("process.stdout.write('out'); process.stderr.write('err'); process.exitCode = 7") });
  assert.equal(result.exitCode, 7);
  assert.equal(result.stdout, "out");
  assert.equal(result.stderr, "err");
  assert.equal(result.signal, null);
});

test("retained output is bounded while the output callback receives the full stream", async (t) => {
  const { runtime } = await fixture(t);
  let streamed = "";
  const result = await runtime.exec("local", {
    command: nodeCommand("process.stdout.write('x'.repeat(100000))"),
    maxOutputBytes: 128,
    onOutput: ({ data }) => { streamed += data; },
  });
  assert.equal(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr), 128);
  assert.equal(streamed.length, 100000);
  assert.equal(result.truncated, true);
});

test("streaming preserves UTF-8 characters split across chunks", async (t) => {
  const { runtime } = await fixture(t);
  let streamed = "";
  const result = await runtime.exec("local", {
    command: nodeCommand("const b=Buffer.from('你好'); process.stdout.write(b.subarray(0,2)); setTimeout(()=>process.stdout.write(b.subarray(2)),30)"),
    onOutput: ({ data }) => { streamed += data; },
  });
  assert.equal(result.stdout, "你好");
  assert.equal(streamed, "你好");
});

test("timeouts terminate long-running commands", async (t) => {
  const { runtime } = await fixture(t);
  await assert.rejects(runtime.exec("local", { command: "sleep 30", timeoutMs: 50 }), hasCode("TIMEOUT"));
});

test("abort cancels an active command and prevents its child from writing later", async (t) => {
  const { runtime, cwd } = await fixture(t);
  const controller = new AbortController();
  const child = nodeCommand("setTimeout(()=>require('node:fs').writeFileSync('leaked','bad'),500)");
  await assert.rejects(runtime.exec("local", {
    command: `${child} &\nprintf ready\nwait`,
    signal: controller.signal,
    onOutput: () => controller.abort(),
  }), hasCode("CANCELLED"));
  await new Promise((resolve) => setTimeout(resolve, 700));
  await assert.rejects(access(join(cwd, "leaked")), { code: "ENOENT" });
});

test("one-shot shell completion also cleans up its process group", async (t) => {
  const { runtime } = await fixture(t);
  const result = await runtime.exec("local", { command: "sleep 30 &\nprintf done", timeoutMs: 2000 });
  assert.equal(result.stdout, "done");
  assert.equal(result.exitCode, 0);
});

test("pre-cancelled operations have no side effects", async (t) => {
  const { runtime, cwd } = await fixture(t);
  const signal = AbortSignal.abort();
  await assert.rejects(runtime.writeFile("local", "cancelled", "data", { signal }), hasCode("CANCELLED"));
  await assert.rejects(runtime.exec("local", { command: "touch cancelled", signal }), hasCode("CANCELLED"));
  await assert.rejects(access(join(cwd, "cancelled")), { code: "ENOENT" });
});

test("paths containing shell syntax are treated as literal file names", async (t) => {
  const { runtime } = await fixture(t);
  const path = "name ' $(touch injected).txt";
  await runtime.writeFile("local", path, "literal");
  assert.equal(new TextDecoder().decode(await runtime.readFile("local", path)), "literal");
  await assert.rejects(runtime.stat("local", "injected"), hasCode("FILE_NOT_FOUND"));
});

test("missing files and shell spawn failures have typed errors", async (t) => {
  const { runtime, cwd } = await fixture(t);
  await assert.rejects(runtime.readFile("local", "absent"), hasCode("FILE_NOT_FOUND"));
  const invalid = new Runtime([new LocalEnvironment({ id: "invalid", cwd, shell: "/missing/agent-kit-prototype-shell" })]);
  await assert.rejects(invalid.exec("invalid", { command: "anything" }), hasCode("EXECUTION_FAILED"));
});

test("invalid execution limits and paths are rejected before execution", async (t) => {
  const { runtime } = await fixture(t);
  for (const value of [0, -1, NaN, Infinity, 1.5, 2_147_483_648]) {
    await assert.rejects(runtime.exec("local", { command: "true", timeoutMs: value }), hasCode("INVALID_ARGUMENT"));
  }
  await assert.rejects(runtime.exec("local", { command: "true", maxOutputBytes: 0 }), hasCode("INVALID_ARGUMENT"));
  await assert.rejects(runtime.readFile("local", "file", { offset: -1 }), hasCode("INVALID_ARGUMENT"));
  await assert.rejects(runtime.readFile("local", "file", { length: 0 }), hasCode("INVALID_ARGUMENT"));
  await assert.rejects(runtime.writeFile("local", "bad\0path", "data"), hasCode("INVALID_ARGUMENT"));
  await assert.rejects(runtime.exec("local", { command: "true", env: { "BAD=NAME": "value" } }), hasCode("INVALID_ARGUMENT"));
});
