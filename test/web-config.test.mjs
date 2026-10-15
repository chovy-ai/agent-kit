import assert from "node:assert/strict";
import { test } from "node:test";
import { isAbsolute } from "node:path";
import { webConfiguration } from "../scripts/web-config.mjs";

test("web configuration keeps the model key in the server environment", () => {
  const secret = "test-only-not-a-real-key";
  const config = webConfiguration({ port: "9001", config: "./examples/agent-kit.config.json" }, { AGENT_KIT_API_KEY: secret });
  assert.equal(config.port, 9001);
  assert.ok(isAbsolute(config.agentDir));
  assert.ok(isAbsolute(config.environmentConfig));
  assert.equal(config.models.providers.sub2api.api, "openai-responses");
  assert.equal(config.models.providers.sub2api.apiKey, "${AGENT_KIT_API_KEY}");
  assert.equal(config.settings.defaultModel, "gpt-6.1-sol");
  assert.equal(config.ui, "chat");
  assert.ok(!JSON.stringify(config).includes(secret));
});

test("web startup rejects missing keys, invalid ports, and credentials in URLs", () => {
  assert.throws(() => webConfiguration({}, {}), /AGENT_KIT_API_KEY/);
  for (const port of ["0", "70000", "abc", "1.5"]) assert.throws(() => webConfiguration({ port }, { AGENT_KIT_API_KEY: "test" }), /port/);
  assert.throws(() => webConfiguration({}, { AGENT_KIT_API_KEY: "test", AGENT_KIT_MODEL_BASE_URL: "http://user:secret@localhost/v1" }), /without credentials/);
  assert.throws(() => webConfiguration({ ui: "unknown" }, { AGENT_KIT_API_KEY: "test" }), /chat or classic/);
  assert.equal(webConfiguration({ ui: "classic" }, { AGENT_KIT_API_KEY: "test" }).ui, "classic");
});
