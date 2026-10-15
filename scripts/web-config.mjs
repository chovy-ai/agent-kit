import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

export function webConfiguration(options = {}, env = process.env) {
  const ui = options.ui ?? env.AGENT_KIT_WEB_UI ?? "chat";
  if (!["chat", "classic"].includes(ui)) throw new Error("Web UI must be chat or classic");
  const port = Number(options.port ?? env.AGENT_KIT_WEB_PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Web port must be an integer between 1 and 65535");
  if (!env.AGENT_KIT_API_KEY?.trim()) throw new Error("Set AGENT_KIT_API_KEY in .env.web.local (see .env.example)");
  const baseUrl = new URL(env.AGENT_KIT_MODEL_BASE_URL ?? "http://127.0.0.1:8080/v1");
  if (!["http:", "https:"].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password) throw new Error("Model base URL must be an HTTP(S) URL without credentials");
  const stateDir = resolve(options["state-dir"] ?? env.AGENT_KIT_WEB_STATE_DIR ?? join(repositoryRoot, ".agent-kit/web"));
  const agentDir = join(stateDir, "agent");
  const cwd = resolve(options.cwd ?? env.AGENT_KIT_WEB_CWD ?? repositoryRoot);
  const environmentConfig = options.config ?? env.AGENT_KIT_ENV_CONFIG;
  return {
    port, stateDir, agentDir, cwd, ui,
    environmentConfig: environmentConfig ? resolve(environmentConfig) : undefined,
    settings: {
      defaultProvider: "sub2api", defaultModel: env.AGENT_KIT_MODEL ?? "gpt-6.1-sol",
      defaultThinkingLevel: "low", cacheWarming: "off",
      extensions: [join(repositoryRoot, "dist/integrations/pi-extension.js")],
    },
    models: { providers: { sub2api: {
      name: "Local Sub2API", baseUrl: baseUrl.href.replace(/\/$/, ""), api: "openai-responses",
      apiKey: "${AGENT_KIT_API_KEY}", authHeader: true,
      models: [{ id: env.AGENT_KIT_MODEL ?? "gpt-6.1-sol", name: env.AGENT_KIT_MODEL ?? "gpt-6.1-sol", reasoning: true, input: ["text"], contextWindow: 32768, maxTokens: 4096 }],
    } } },
  };
}
