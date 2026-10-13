import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { posix } from "node:path";
import { test } from "node:test";
import { RuntimeClient as contractClient } from "../src/modules/go-bridge/index.js";
import { RuntimeClient as compatibleClient } from "../src/client.js";
import { RuntimeClient as oldContractClient } from "../src/runtime-client.js";
import { RuntimeClient as publicClient } from "../src/index.js";

const modules: Record<string, readonly string[]> = {
  "go-bridge": [],
  "environment": ["go-bridge"],
  "filesystem": ["environment", "go-bridge"],
  "process": ["environment", "go-bridge"],
  "agent": ["environment", "filesystem", "process", "go-bridge"],
};
const legacy: Record<string, readonly string[]> = {
  "bootstrap.ts": ["bootstrap/application.ts", "bootstrap/layers.ts"],
  "client.ts": ["runtime-client.ts", "stdio-client.ts"],
  "runtime-client.ts": ["modules/go-bridge/index.ts"],
  "stdio-client.ts": ["modules/go-bridge/index.ts", "modules/go-bridge/live.ts"],
  "protocol.ts": ["modules/go-bridge/protocol.ts"],
  "pi.ts": ["modules/go-bridge/index.ts", "modules/agent/index.ts", "tooling/index.ts", "bootstrap/layers.ts"],
  "main.ts": ["bootstrap.ts", "modules/agent/index.ts", "modules/go-bridge/index.ts"],
};

function allowedDependency(file: string, target: string): boolean {
  if (file === "index.ts" || file.startsWith("bootstrap/")) return true;
  if (legacy[file]) return legacy[file].includes(target);
  if (file.startsWith("tooling/")) return target.startsWith("tooling/") || target === "modules/go-bridge/index.ts";
  const owner = file.split("/")[1]!;
  const consumer = target.split("/")[1]!;
  if (!(owner in modules)) return false;
  if (target.startsWith(`modules/${owner}/`)) {
    return !file.endsWith("/service.ts") && !file.endsWith("/index.ts") || !target.endsWith("/live.ts");
  }
  if (target === "tooling/index.ts") return file.endsWith("/tools.ts") || file.endsWith("/diagnostics.ts");
  if (!target.startsWith("modules/") || !modules[owner]!.includes(consumer)) return false;
  if (target === `modules/${consumer}/index.ts`) return true;
  // The registry is a composition entry for public Pi adapters, not a service caller.
  return file === "modules/agent/tools.ts" && target === `modules/${consumer}/tools.ts`;
}

function allowedExternal(file: string, specifier: string): boolean {
  if (specifier === "effect") return true;
  if (specifier === "typebox") return file.endsWith("/tools.ts") || file === "modules/agent/diagnostics.ts" || file === "tooling/schema.ts";
  if (specifier === "@earendil-works/pi-coding-agent") return file.startsWith("modules/agent/") || file.endsWith("/tools.ts");
  if (specifier === "node:util") return file === "main.ts";
  return file === "modules/go-bridge/live.ts" && ["node:child_process", "node:crypto", "node:url"].includes(specifier);
}

test("TypeScript modules use public contracts and startup alone selects implementations", async () => {
  const root = new URL("../src/", import.meta.url);
  for (const entry of await readdir(root, { recursive: true })) {
    const file = entry.replaceAll("\\", "/");
    if (!file.endsWith(".ts")) continue;
    assert.ok(file === "index.ts" || legacy[file] || file.startsWith("bootstrap/") || file.startsWith("tooling/") || modules[file.split("/")[1]!], `${file} needs a declared boundary`);
    const source = await readFile(new URL(file, root), "utf8");
    const specifiers = /\b(?:from\s*|import\s*\(?\s*|require\s*\(\s*)["']([^"']+)["']/g;
    for (const match of source.matchAll(specifiers)) {
      const specifier = match[1]!;
      if (specifier.startsWith(".")) {
        const target = posix.normalize(posix.join(posix.dirname(file), specifier)).replace(/\.js$/, ".ts");
        assert.ok(allowedDependency(file, target), `${file} cannot depend on ${target}`);
      } else assert.ok(allowedExternal(file, specifier), `${file} cannot import ${specifier}`);
    }
    if (file.endsWith("/tools.ts") || file.endsWith("/diagnostics.ts")) {
      assert.ok(!/\.request\s*\(/.test(source), `${file} must call a capability service`);
    }
  }
});

test("dependency rules reject concrete cross-module access and private module imports", () => {
  assert.equal(allowedDependency("modules/filesystem/tools.ts", "modules/go-bridge/live.ts"), false);
  assert.equal(allowedDependency("modules/process/live.ts", "modules/filesystem/live.ts"), false);
  assert.equal(allowedDependency("modules/process/service.ts", "modules/process/live.ts"), false);
  assert.equal(allowedDependency("modules/environment/live.ts", "modules/go-bridge/service.ts"), false);
  assert.equal(allowedDependency("bootstrap/layers.ts", "modules/filesystem/live.ts"), true);
});

test("public and compatibility exports preserve the same Effect service identity", () => {
  assert.equal(compatibleClient, contractClient);
  assert.equal(oldContractClient, contractClient);
  assert.equal(publicClient, contractClient);
});
