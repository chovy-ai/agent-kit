import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { RuntimeClient as contractClient } from "../src/runtime-client.js";
import { RuntimeClient as compatibleClient } from "../src/client.js";
import { RuntimeClient as publicClient } from "../src/index.js";

test("TypeScript consumers keep startup and stdio behind the runtime contract", async () => {
  const allowed: Record<string, readonly string[]> = {
    "runtime-client.ts": ["effect", "./protocol.js"],
    "protocol.ts": [],
    "pi.ts": ["@earendil-works/pi-coding-agent", "effect", "typebox", "./runtime-client.js", "./protocol.js"],
    "stdio-client.ts": ["node:child_process", "node:crypto", "node:url", "effect", "./protocol.js", "./runtime-client.js"],
    "bootstrap.ts": ["effect", "./runtime-client.js", "./stdio-client.js", "./pi.js", "./protocol.js"],
    "main.ts": ["node:util", "@earendil-works/pi-coding-agent", "effect", "./bootstrap.js", "./runtime-client.js"],
    "index.ts": ["./bootstrap.js", "./runtime-client.js", "./stdio-client.js", "./protocol.js"],
    "client.ts": ["./runtime-client.js", "./stdio-client.js"],
  };
  const root = new URL("../src/", import.meta.url);
  for (const entry of await readdir(root, { recursive: true })) {
    const file = entry.replaceAll("\\", "/");
    if (!file.endsWith(".ts")) continue;
    assert.ok(allowed[file], `${file} needs a declared dependency policy`);
    const source = await readFile(new URL(file, root), "utf8");
    // Check static imports/re-exports, literal dynamic imports and require calls.
    const specifiers = /\b(?:from\s*|import\s*\(?\s*|require\s*\(\s*)["']([^"']+)["']/g;
    for (const match of source.matchAll(specifiers)) {
      assert.ok(allowed[file].includes(match[1]!), `${file} cannot import ${match[1]}`);
    }
  }
});

test("the public and compatibility exports preserve the same Effect service identity", () => {
  assert.equal(compatibleClient, contractClient);
  assert.equal(publicClient, contractClient);
});
