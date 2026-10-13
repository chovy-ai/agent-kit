import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { LocalEnvironment, Runtime } from "agent-kit-prototype";
import { createRuntimeTools } from "agent-kit-prototype/pi";

const runtime = new Runtime([
  new LocalEnvironment({ id: "local", cwd: process.cwd(), description: "Current local workspace" }),
]);
const tools = createRuntimeTools(runtime);
const { session } = await createAgentSession({
  customTools: tools,
  tools: tools.map((tool) => tool.name),
  sessionManager: SessionManager.inMemory(),
});
try {
  await session.prompt("List the available environments, then list the current directory in the local environment.");
  console.log(session.getLastAssistantText());
} finally {
  session.dispose();
}
