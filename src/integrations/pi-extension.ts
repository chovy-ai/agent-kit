import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAgentKit } from "../bootstrap.js";
import type { RunnerOptions } from "../modules/go-bridge/index.js";

/** One extension runtime owns one Effect application and Go runner. */
export function createAgentKitExtension(runner?: RunnerOptions) {
  return (pi: ExtensionAPI): void => {
    let application: Promise<Awaited<ReturnType<typeof createAgentKit>>> | undefined;
    let closed = false;
    let names: string[] = [];

    pi.on("session_start", async (_event, context) => {
      if (closed) throw new Error("Agent Kit extension is closed");
      application ??= createAgentKit(runner ?? { args: ["--cwd", context.cwd] });
      const app = await application;
      if (closed) { await app.close(); return; }
      for (const tool of app.tools) pi.registerTool({
        ...tool,
        promptSnippet: tool.description,
        promptGuidelines: tool.name === "environment_list"
          ? ["Use environment_list to discover targets. Every file or command operation must specify an environmentId. Complex file operations use process_exec in that same environment."] : [],
      });
      names = app.tools.map((tool) => tool.name);
      pi.setActiveTools(names);
    });

    // Hosts may reset the active tool set after binding extensions or loading a
    // UI preset. Reapply at each model turn, and reject calls outside the bridge.
    pi.on("before_agent_start", () => { pi.setActiveTools(closed ? [] : names); });
    pi.on("tool_call", (event) => {
      if (closed || !names.includes(event.toolName)) return {
        block: true,
        reason: "Use Agent Kit tools with an explicit environmentId; host-native tools are disabled in this session.",
      };
      return undefined;
    });
    pi.on("user_bash", () => ({ result: {
      output: "Use process_exec with an explicit environmentId to run commands through Agent Kit.",
      exitCode: 1, cancelled: false, truncated: false,
    } }));

    pi.on("session_shutdown", async () => {
      closed = true;
      names = [];
      // Initialization already releases its own resources on failure.
      const app = await application?.catch(() => undefined);
      await app?.close();
    });
  };
}

export default function agentKitExtension(pi: ExtensionAPI): void {
  const configPath = process.env.AGENT_KIT_ENV_CONFIG;
  createAgentKitExtension(configPath ? { configPath } : undefined)(pi);
}
