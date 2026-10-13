import { parseArgs } from "node:util";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { createAgentKit } from "./bootstrap.js";
import { RuntimeClient } from "./runtime-client.js";

const { values } = parseArgs({ options: { runner: { type: "string" }, prompt: { type: "string" }, "remote-endpoint": { type: "string" }, "remote-target": { type: "string" }, cwd: { type: "string" }, bash: { type: "string" } } });
let app: Awaited<ReturnType<typeof createAgentKit>> | undefined;
let session: AgentSession | undefined;
let stopping = false;
const stop = () => {
  stopping = true;
  void session?.abort().catch(() => {});
  void app?.close().catch(() => {});
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
  const args: string[] = [];
  for (const key of ["remote-endpoint", "remote-target", "cwd", "bash"] as const) if (values[key] !== undefined) args.push(`--${key}`, values[key]!);
  app = await createAgentKit({ ...(values.runner === undefined ? {} : { runnerPath: values.runner }), args });
  if (stopping) await app.close();
  else if (values.prompt !== undefined) {
    ({ session } = await createAgentSession({
      customTools: app.tools, tools: app.tools.map((tool) => tool.name), sessionManager: SessionManager.inMemory(),
    }));
    if (!stopping) await session.prompt(values.prompt);
    console.log(session.getLastAssistantText() ?? "");
  } else {
    const ping = await app.runtime.runPromise(Effect.gen(function* () {
      const client = yield* RuntimeClient;
      return yield* client.ping();
    }));
    console.log(JSON.stringify({ framework: app.hello, ping }, null, 2));
  }
} catch (error) {
  if (!stopping) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
} finally {
  session?.dispose();
  await app?.close();
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
}
