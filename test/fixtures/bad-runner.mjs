import { createInterface } from "node:readline";

const mode = process.argv[2];
if (mode === "exit") process.exit(17);
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (mode === "hang") return;
  if (mode === "malformed") process.stdout.write("not-json\n");
  else if (mode === "oversized") process.stdout.write("x".repeat(4096));
  else if (mode === "version") process.stdout.write(JSON.stringify({ version: 99, id: request.id, type: "result", result: {} }) + "\n");
});
