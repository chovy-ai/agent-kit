import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalEnvironment, Runtime } from "agent-kit-prototype";

const workspace = await mkdtemp(join(tmpdir(), "agent-kit-prototype-example-"));
try {
  const runtime = new Runtime([
    new LocalEnvironment({ id: "local", cwd: workspace, description: "Temporary local workspace" }),
  ]);
  await runtime.writeFile("local", "greeting.txt", "Hello from the selected environment!\n");
  console.log(await runtime.exec("local", { command: "cat greeting.txt" }));
  console.log(new TextDecoder().decode(await runtime.readFile("local", "greeting.txt")));
} finally {
  await rm(workspace, { recursive: true, force: true });
}
