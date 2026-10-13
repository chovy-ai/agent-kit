import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentToolUpdateCallback, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, validateToolArguments } from "@earendil-works/pi-ai";
import type { AssistantMessage, JsonObject, Model } from "@earendil-works/pi-ai";
import { LocalEnvironment, Runtime } from "../src/index.js";
import { createRuntimeTools } from "../src/pi/index.js";
import { MemoryTestEnvironment } from "./fixtures/memory-environment.js";

async function fixture(t: TestContext, options: Parameters<typeof createRuntimeTools>[1] = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "agent-kit-prototype-pi-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const remote = new MemoryTestEnvironment();
  const runtime = new Runtime([new LocalEnvironment({ id: "local", cwd }), remote]);
  const tools = createRuntimeTools(runtime, options);
  const invoke = async (name: string, args: JsonObject, signal?: AbortSignal, onUpdate?: AgentToolUpdateCallback) => {
    const definition = tools.find((tool) => tool.name === name)!;
    const params = validateToolArguments(definition, { type: "toolCall", id: "test", name, arguments: args });
    // Runtime tools deliberately do not depend on Pi's host cwd or UI context.
    return definition.execute("test", params, signal, onUpdate, {} as ExtensionToolContext);
  };
  return { cwd, remote, runtime, tools, invoke };
}

function body(result: Awaited<ReturnType<ReturnType<typeof createRuntimeTools>[number]["execute"]>>) {
  const content = result.content[0];
  assert.ok(content?.type === "text");
  return JSON.parse(content.text);
}

test("Pi schemas require environmentId and reject invalid limits before dispatch", async (t) => {
  const { invoke, remote } = await fixture(t);
  await assert.rejects(invoke("runtime_exec", { command: "anything" }));
  await assert.rejects(invoke("runtime_read_file", { environmentId: "remote-test", path: "file", maxBytes: -1 }));
  assert.equal(remote.requests.length + remote.fileCalls.length, 0);
});

test("Pi tools select the requested environment for both files and commands", async (t) => {
  const { invoke } = await fixture(t);
  const listing = body(await invoke("runtime_list_environments", {})).result;
  assert.deepEqual(listing.map((descriptor: { id: string }) => descriptor.id), ["local", "remote-test"]);
  await invoke("runtime_write_file", { environmentId: "local", path: "same.txt", content: "local" });
  await invoke("runtime_write_file", { environmentId: "remote-test", path: "same.txt", content: "remote" });
  assert.equal(body(await invoke("runtime_read_file", { environmentId: "local", path: "same.txt" })).result.text, "local");
  assert.equal(body(await invoke("runtime_read_file", { environmentId: "remote-test", path: "same.txt" })).result.text, "remote");
  assert.equal(body(await invoke("runtime_exec", { environmentId: "local", command: "cat same.txt" })).result.stdout, "local");
  assert.equal(body(await invoke("runtime_exec", { environmentId: "remote-test", command: "remote-only" })).result.stdout, "from remote test adapter");
});

test("Pi returns typed errors, command failure status, timeout status and streamed environment labels", async (t) => {
  const { invoke } = await fixture(t);
  const unknown = await invoke("runtime_read_file", { environmentId: "absent", path: "file" });
  assert.equal(unknown.isError, true);
  assert.equal(body(unknown).code, "UNKNOWN_ENVIRONMENT");
  const failure = await invoke("runtime_exec", { environmentId: "local", command: "exit 9" });
  assert.equal(failure.isError, true);
  assert.equal(body(failure).result.exitCode, 9);
  const timeout = await invoke("runtime_exec", { environmentId: "local", command: "sleep 30", timeoutMs: 30 });
  assert.equal(timeout.isError, true);
  assert.equal(body(timeout).code, "TIMEOUT");
  const updates: string[] = [];
  await invoke("runtime_exec", { environmentId: "remote-test", command: "remote" }, undefined, (partial) => {
    const content = partial.content[0];
    if (content?.type === "text") updates.push(content.text);
  });
  assert.deepEqual(updates, ["[remote-test:stdout] from remote test adapter"]);
});

test("bounded UTF-8 reads continue without dropping or splitting multibyte characters", async (t) => {
  const { invoke, remote } = await fixture(t, { maxReadBytes: 5 });
  const original = "a你好🙂尾";
  await invoke("runtime_write_file", { environmentId: "remote-test", path: "utf8", content: original });
  let offset = 0;
  let assembled = "";
  while (true) {
    const result = body(await invoke("runtime_read_file", { environmentId: "remote-test", path: "utf8", offset })).result;
    assembled += result.text;
    assert.ok(result.bytesRead <= 5);
    if (!result.truncated) break;
    assert.ok(result.nextOffset > offset);
    offset = result.nextOffset;
  }
  assert.equal(assembled, original);
  assert.ok(remote.fileCalls.filter((call) => call.operation === "readFile").length > 1);
});

test("binary files are available through the SDK and rejected by the text tool", async (t) => {
  const { invoke, runtime } = await fixture(t);
  await runtime.writeFile("remote-test", "binary", new Uint8Array([0, 255]));
  const result = await invoke("runtime_read_file", { environmentId: "remote-test", path: "binary" });
  assert.equal(result.isError, true);
  assert.equal(body(result).code, "INVALID_ARGUMENT");
});

test("Pi directory previews are bounded and all filesystem tools use the selected adapter", async (t) => {
  const { invoke } = await fixture(t, { maxDirectoryEntries: 1 });
  await invoke("runtime_mkdir", { environmentId: "remote-test", path: "dir", recursive: true });
  await invoke("runtime_write_file", { environmentId: "remote-test", path: "dir/a", content: "a" });
  await invoke("runtime_write_file", { environmentId: "remote-test", path: "dir/b", content: "b" });
  const result = body(await invoke("runtime_list_directory", { environmentId: "remote-test", path: "dir" })).result;
  assert.equal(result.entries.length, 1);
  assert.equal(result.total, 2);
  assert.equal(result.truncated, true);
  assert.equal(body(await invoke("runtime_stat", { environmentId: "remote-test", path: "dir/a" })).result.size, 1);
});

test("real Pi SDK runs a tool loop with an offline model stub and only runtime tools active", async (t) => {
  const { cwd, tools, runtime } = await fixture(t);
  const agentDir = join(cwd, ".pi-test");
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"), modelsPath: null,
    modelsStorePath: join(agentDir, "models-cache.json"), refreshOnCreate: false,
  });
  await modelRuntime.setRuntimeApiKey("anthropic", "test-only-unused-key");
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: "off" });
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager, noExtensions: true, noSkills: true,
    noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await resourceLoader.reload();
  const model: Model<"anthropic-messages"> = {
    id: "runtime-test", name: "Offline test model", provider: "anthropic", api: "anthropic-messages", baseUrl: "http://unused.invalid",
    reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 1000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const { session } = await createAgentSession({
    cwd, agentDir, model, modelRuntime, settingsManager, resourceLoader,
    sessionManager: SessionManager.inMemory(cwd), customTools: tools, tools: tools.map((tool) => tool.name),
  });
  t.after(() => session.dispose());
  assert.deepEqual(session.getActiveToolNames().sort(), tools.map((tool) => tool.name).sort());
  let calls = 0;
  session.agent.streamFunction = (_model, context) => {
    const step = calls++;
    if (step === 2) {
      const result = context.messages.filter((message) => message.role === "toolResult").at(-1);
      assert.ok(result?.role === "toolResult" && result.content[0]?.type === "text");
      assert.equal(JSON.parse(result.content[0].text).result.stdout, "through Pi");
    }
    const message: AssistantMessage = {
      role: "assistant", api: model.api, model: model.id, provider: model.provider, timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: step < 2 ? "toolUse" : "stop",
      content: step === 0 ? [{
        type: "toolCall", id: "write", name: "runtime_write_file",
        arguments: { environmentId: "local", path: "pi.txt", content: "through Pi" },
      }] : step === 1 ? [{
        type: "toolCall", id: "exec", name: "runtime_exec",
        arguments: { environmentId: "local", command: "cat pi.txt" },
      }] : [{ type: "text", text: "done" }],
    };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "start", partial: message });
    stream.push({ type: "done", reason: step < 2 ? "toolUse" : "stop", message });
    return stream;
  };
  await session.prompt("Exercise the runtime tools");
  assert.equal(calls, 3);
  assert.equal(session.getLastAssistantText(), "done");
  assert.equal(new TextDecoder().decode(await runtime.readFile("local", "pi.txt")), "through Pi");
});
