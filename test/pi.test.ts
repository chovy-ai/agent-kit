import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { createAgentKit } from "../src/bootstrap.js";

test("real Pi SDK uses Effect-backed status, file and Bash tools", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-kit-pi-"));
  const app = await createAgentKit({ args: ["--cwd", cwd] });
  // Register cleanup immediately so initialization failures also release the process.
  t.after(async () => {
    await app.close();
    await rm(cwd, { recursive: true, force: true });
  });
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
    id: "framework-test", name: "Offline test model", provider: "anthropic", api: "anthropic-messages", baseUrl: "http://unused.invalid",
    reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 1000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const { session } = await createAgentSession({
    cwd, agentDir, model, modelRuntime, settingsManager, resourceLoader,
    sessionManager: SessionManager.inMemory(cwd), customTools: app.tools, tools: app.tools.map((tool) => tool.name),
  });
  t.after(() => session.dispose());
  assert.deepEqual(session.getActiveToolNames(), app.tools.map((tool) => tool.name));
  assert.ok(session.getActiveToolNames().includes("process_exec"));
  let calls = 0;
  session.agent.streamFunction = (_model, context) => {
    const step = calls++;
    if (step === 1) {
      const result = context.messages.filter((message) => message.role === "toolResult").at(-1);
      assert.ok(result?.role === "toolResult" && result.content[0]?.type === "text");
      assert.equal(JSON.parse(result.content[0].text).name, "agent-kit");
      assert.equal(result.isError, false);
    }
    if (step === 3) {
      const result = context.messages.filter((message) => message.role === "toolResult").at(-1);
      assert.ok(result?.role === "toolResult" && result.content[0]?.type === "text");
      assert.equal(JSON.parse(result.content[0].text).stdout, "Pi writes");
      assert.equal(result.isError, false);
    }
    const message: AssistantMessage = {
      role: "assistant", api: model.api, model: model.id, provider: model.provider, timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: step < 3 ? "toolUse" : "stop",
      content: step === 0 ? [{ type: "toolCall", id: "status", name: "agent_kit_status", arguments: {} }]
        : step === 1 ? [{ type: "toolCall", id: "write", name: "filesystem_write", arguments: { environmentId: "local", path: "pi.txt", content: "Pi writes" } }]
        : step === 2 ? [{ type: "toolCall", id: "exec", name: "process_exec", arguments: { environmentId: "local", command: "cat pi.txt" } }]
        : [{ type: "text", text: "framework ready" }],
    };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "start", partial: message });
    stream.push({ type: "done", reason: step < 3 ? "toolUse" : "stop", message });
    return stream;
  };
  await session.prompt("Check framework status");
  assert.equal(calls, 4);
  assert.equal(session.getLastAssistantText(), "framework ready");
});
