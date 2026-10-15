import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const tarball = join(root, ".build/packages", `${pkg.name}-${pkg.version}.tgz`);
const project = await mkdtemp(join(tmpdir(), "agent-kit-package-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: project, stdio: "inherit", timeout: 120000, ...options });
  if (result.error || result.status !== 0) throw result.error ?? new Error(`Package acceptance failed: ${command}`);
}
try {
  await writeFile(join(project, "package.json"), JSON.stringify({ private: true, type: "module" }));
  run(npm, ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], { shell: process.platform === "win32" });
  const tree = spawnSync(npm, ["ls", "--all", "--json"], { cwd: project, encoding: "utf8", shell: process.platform === "win32" });
  const versions = {};
  function inspect(node) {
    for (const [name, dependency] of Object.entries(node.dependencies ?? {})) {
      if (name.startsWith("@earendil-works/pi-")) versions[name] = dependency.version;
      inspect(dependency);
    }
  }
  inspect(JSON.parse(tree.stdout));
  console.log("Installed Pi dependencies:", JSON.stringify(versions));
  await writeFile(join(project, "acceptance.mjs"), String.raw`
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { Effect } from "effect";
import { createAgentKit, EnvironmentService, FilesystemService, ProcessService, RuntimeClient } from "agent-kit";
for (const name of ["agent", "environment", "filesystem", "process", "go-bridge", "pi", "pi-extension"]) await import("agent-kit/" + name);
await Promise.all([mkdir("workspace"), mkdir("scratch")]);
const app = await createAgentKit({ environments: {
  workspace: { type: "local", cwd: join(process.cwd(), "workspace") },
  scratch: { type: "local", cwd: join(process.cwd(), "scratch") },
} });
let pid;
try {
  await app.runtime.runPromise(Effect.gen(function* () {
    pid = (yield* (yield* RuntimeClient).connectionInfo).pid;
    assert.deepEqual((yield* (yield* EnvironmentService).list()).environments, ["scratch", "workspace"]);
    const fs = yield* FilesystemService; const processService = yield* ProcessService;
    for (const environmentId of ["workspace", "scratch"]) {
      yield* fs.write({ environmentId, path: "proof.txt", data: Buffer.from(environmentId + " 中文") });
      const result = yield* processService.exec({ environmentId, command: "cat proof.txt" });
      assert.equal(Buffer.from(result.stdout).toString(), environmentId + " 中文");
      assert.equal(result.exitCode, 0);
    }
  }));
  const controller = new AbortController();
  await assert.rejects(app.runtime.runPromise(Effect.gen(function* () {
    return yield* (yield* ProcessService).exec({ environmentId: "scratch", command: "printf ready; sleep 30" }, () => controller.abort());
  }), { signal: controller.signal }));
  const result = await app.runtime.runPromise(Effect.gen(function* () {
    return yield* (yield* ProcessService).exec({ environmentId: "workspace", command: "printf reused" });
  }));
  assert.equal(Buffer.from(result.stdout).toString(), "reused");
  assert.equal(await readFile("workspace/proof.txt", "utf8"), "workspace 中文");
} finally { await app.close(); }
assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
const cli = process.platform === "win32" ? join(process.cwd(), "node_modules/agent-kit/dist/main.js") : join(process.cwd(), "node_modules/.bin/agent-kit");
const args = process.platform === "win32" ? [cli] : [];
const check = spawnSync(process.platform === "win32" ? process.execPath : cli, [...args, "--config", "node_modules/agent-kit/examples/agent-kit.config.json"], { encoding: "utf8" });
assert.equal(check.status, 0, check.stderr);
assert.equal(JSON.parse(check.stdout).framework.name, "agent-kit");
console.log("Package acceptance passed: exports, bundled runner, named files/processes, cancellation, cleanup and CLI");
`);
  const env = { ...process.env };
  delete env.AGENT_KIT_RUNNER;
  if (process.platform !== "win32") env.PATH = `${dirname(process.execPath)}:/usr/bin:/bin`;
  run(process.execPath, [join(project, "acceptance.mjs")], { env });
} finally { await rm(project, { recursive: true, force: true }); }
