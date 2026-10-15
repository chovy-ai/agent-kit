import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Effect } from "effect";
import { createAgentKit, EnvironmentService, FilesystemService, ProcessService } from "../src/index.js";

test("named local instances route files and commands to their configured directories", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agent-kit-named-"));
  const workspace = join(root, "workspace"); const scratch = join(root, "scratch");
  await Promise.all([mkdir(workspace), mkdir(scratch)]);
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = await createAgentKit({ environments: { workspace: { type: "local", cwd: workspace }, scratch: { type: "local", cwd: scratch } } });
  t.after(() => app.close());
  await app.runtime.runPromise(Effect.gen(function* () {
    assert.deepEqual((yield* (yield* EnvironmentService).list()).environments, ["scratch", "workspace"]);
    const files = yield* FilesystemService; const processes = yield* ProcessService;
    for (const environmentId of ["workspace", "scratch"]) {
      yield* files.write({ environmentId, path: "same.txt", data: Buffer.from(environmentId) });
      const result = yield* processes.exec({ environmentId, command: "cat same.txt" });
      assert.equal(Buffer.from(result.stdout).toString(), environmentId);
      assert.equal(result.completion, "finished");
    }
  }));
  const tool = app.tools.find((tool) => tool.name === "filesystem_read")!;
  const result = await tool.execute("named", { environmentId: "scratch", path: "same.txt" }, undefined, undefined, {} as never);
  assert.equal(result.isError, false);
  await assert.rejects(app.runtime.runPromise(Effect.gen(function* () {
    return yield* (yield* FilesystemService).write({ environmentId: "local", path: "unexpected", data: Buffer.from("bad") });
  })), { code: "NOT_FOUND" });
  assert.equal(await readFile(join(workspace, "same.txt"), "utf8"), "workspace");
});

test("configuration files resolve named local paths relative to the file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agent-kit-config-"));
  await mkdir(join(root, "project"));
  const configPath = join(root, "config with spaces.json");
  await writeFile(configPath, JSON.stringify({ version: 1, environments: { project: { type: "local", cwd: "project" } } }));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = await createAgentKit({ configPath }); t.after(() => app.close());
  await app.runtime.runPromise(Effect.gen(function* () { yield* (yield* FilesystemService).write({ environmentId: "project", path: "proof", data: Buffer.from("configured") }); }));
  assert.equal(await readFile(join(root, "project", "proof"), "utf8"), "configured");
});

test("invalid named configurations fail startup without selecting a default environment", async () => {
  for (const options of [
    { environments: {} }, { environments: { invalid: { type: "remote" } } },
    { environments: { local: { type: "local", cwd: "/missing/agent-kit-directory" } } },
    { environments: { local: { type: "local" } }, args: ["--cwd", "."] },
    { environments: { local: { type: "local" } }, configPath: "config.json" },
    { configPath: "" },
    { args: ["--environments-json", '{"version":1,"environments":{"x":{"type":"local"},"x":{"type":"local"}}}'] },
  ]) await assert.rejects(createAgentKit(options as Parameters<typeof createAgentKit>[0]));
});
