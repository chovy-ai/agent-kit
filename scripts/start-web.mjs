import { loadEnvFile } from "node:process";
import { parseArgs } from "node:util";
import { mkdir, readFile, writeFile, access, cp } from "node:fs/promises";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { repositoryRoot, webConfiguration } from "./web-config.mjs";

const { values } = parseArgs({ options: {
  port: { type: "string" }, cwd: { type: "string" }, config: { type: "string" },
  "state-dir": { type: "string" }, "env-file": { type: "string" },
  ui: { type: "string" },
} });
const envFile = values["env-file"] ?? join(repositoryRoot, ".env.web.local");
try { loadEnvFile(envFile); }
catch (error) { if (values["env-file"] || error.code !== "ENOENT") throw error; }

const config = webConfiguration(values);
await access(config.cwd);
if (config.environmentConfig) await access(config.environmentConfig);
const require = createRequire(import.meta.url);
const webRoot = dirname(require.resolve("pi-web-ui/package.json"));
const entry = join(webRoot, "dist/server/index.js");
await access(entry);
await access(config.settings.extensions[0]);
const appRoot = join(config.stateDir, "app");
if (config.ui === "chat") {
  const buildDir = join(repositoryRoot, "web/dist");
  const webDist = join(appRoot, "web/dist");
  await access(join(buildDir, "index.html"));
  // Runtime assets are independent of subsequent build/check cleanup. Keeping
  // hashed assets also lets an already-open page finish loading during restart.
  await mkdir(appRoot, { recursive: true, mode: 0o700 });
  await cp(buildDir, webDist, { recursive: true });
  const { version } = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
  await writeFile(join(appRoot, "package.json"), JSON.stringify({ name: "agent-kit-chat", version }) + "\n");
  let environments = ["local"];
  if (config.environmentConfig) {
    const declared = JSON.parse(await readFile(config.environmentConfig, "utf8")).environments;
    if (!declared || typeof declared !== "object" || Array.isArray(declared) || !Object.keys(declared).length) throw new Error("The environment config must declare named environments");
    environments = Object.keys(declared).sort();
  }
  await writeFile(join(webDist, "agent-kit.json"), JSON.stringify({ environments, model: config.settings.defaultModel }) + "\n");
}
await mkdir(config.agentDir, { recursive: true, mode: 0o700 });
let settings = {};
try { settings = JSON.parse(await readFile(join(config.agentDir, "settings.json"), "utf8")); }
catch (error) { if (error.code !== "ENOENT") throw error; }
// This isolated agent directory belongs to the launcher. Keep unrelated UI/Pi
// preferences, while guaranteeing that the bridge remains a loaded extension.
await writeFile(join(config.agentDir, "settings.json"), JSON.stringify({
  ...config.settings, ...settings,
  extensions: [...new Set([...(settings.extensions ?? []), ...config.settings.extensions])],
}, null, 2) + "\n", { mode: 0o600 });
await writeFile(join(config.agentDir, "models.json"), JSON.stringify(config.models, null, 2) + "\n", { mode: 0o600 });
Object.assign(process.env, {
  PI_WEB_PORT: String(config.port), PI_WEB_HOST: "127.0.0.1", PI_WEB_CWD: config.cwd,
  PI_WEB_DATA_DIR: join(config.stateDir, "ui"), PI_CODING_AGENT_DIR: config.agentDir,
  PI_WEB_ENGINE: "pi", PI_WEB_MANAGED: "1", PI_WEB_TABS: "chat,settings",
  PI_WEB_LOCALE: "zh", PI_WEB_PLUGIN_CATALOG_URL: "off",
  PI_WEB_PKG_ROOT: config.ui === "chat" ? appRoot : webRoot,
});
if (config.environmentConfig) process.env.AGENT_KIT_ENV_CONFIG = config.environmentConfig;
else delete process.env.AGENT_KIT_ENV_CONFIG;
console.log(`Agent Kit chat: http://127.0.0.1:${config.port}`);
await import(pathToFileURL(entry).href);
