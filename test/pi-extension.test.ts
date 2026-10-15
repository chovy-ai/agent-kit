import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createAgentKitExtension } from "../src/integrations/pi-extension.js";

function host() {
  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, (...args: any[]) => any>();
  let active: string[] = [];
  const pi = {
    registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
    on(event: string, handler: (...args: any[]) => any) { handlers.set(event, handler); return () => handlers.delete(event); },
    setActiveTools(names: string[]) { active = [...names]; },
  } as unknown as ExtensionAPI;
  return { pi, tools, handlers, active: () => active,
    emit: async (event: string, data = {}, context = {}) => handlers.get(event)?.(data, context),
    execute: (name: string, params: unknown, signal?: AbortSignal) => tools.get(name)!.execute(name, params, signal, undefined, {} as ExtensionToolContext),
  };
}

test("Pi extension starts lazily, uses named Go environments, and reapplies its tool set", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-kit-extension-"));
  const h = host();
  createAgentKitExtension({ environments: { workspace: { type: "local", cwd } } })(h.pi);
  t.after(async () => { await h.emit("session_shutdown"); await rm(cwd, { recursive: true, force: true }); });
  assert.equal(h.tools.size, 0);
  await h.emit("session_start", {}, { cwd });
  assert.ok(h.active().includes("process_exec"));
  assert.ok(!h.active().includes("bash"));
  const listed = await h.execute("environment_list", {});
  assert.deepEqual(JSON.parse((listed.content[0] as { text: string }).text), { environments: ["workspace"] });
  const written = await h.execute("filesystem_write", { environmentId: "workspace", path: "proof.txt", content: "through Go" });
  assert.equal(written.isError, false);
  const executed = await h.execute("process_exec", { environmentId: "workspace", command: "cat proof.txt" });
  assert.equal(executed.isError, false);
  assert.equal(JSON.parse((executed.content[0] as { text: string }).text).stdout, "through Go");
  assert.equal(await readFile(join(cwd, "proof.txt"), "utf8"), "through Go");
  assert.equal((await h.execute("filesystem_read", { environmentId: "missing", path: "proof.txt" })).isError, true);
  h.pi.setActiveTools(["bash"]);
  await h.emit("before_agent_start");
  assert.deepEqual(h.active(), [...h.tools.keys()]);
  for (const name of ["bash", "read", "terminal_create", "codemode"]) {
    assert.equal((await h.emit("tool_call", { toolName: name })).block, true);
  }
  assert.equal(await h.emit("tool_call", { toolName: "process_exec" }), undefined);
  assert.equal((await h.emit("user_bash", { command: "touch forbidden" })).result.exitCode, 1);
  await h.emit("session_shutdown");
  await h.emit("session_shutdown");
  assert.equal((await h.execute("agent_kit_status", {})).isError, true);
});

test("closing a Pi extension cancels its in-flight Go command", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-kit-extension-close-"));
  const h = host();
  createAgentKitExtension({ environments: { local: { type: "local", cwd } } })(h.pi);
  t.after(async () => { await h.emit("session_shutdown"); await rm(cwd, { recursive: true, force: true }); });
  await h.emit("session_start", {}, { cwd });
  const command = h.execute("process_exec", { environmentId: "local", command: "printf started; sleep 30", timeoutMs: 60000 });
  // Give the request a turn to enter the shared runtime before closing it.
  await new Promise((resolve) => setTimeout(resolve, 50));
  await h.emit("session_shutdown");
  assert.equal((await command).isError, true);
  assert.equal((await h.emit("tool_call", { toolName: "process_exec" })).block, true);
});
