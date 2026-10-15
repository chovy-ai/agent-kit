import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--all")) throw new Error("Use --all for all configured targets");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
for (const [command, arguments_] of [
  [npm, ["run", "build:ts"]],
  [process.execPath, ["scripts/build-go.mjs", "--bundle", ...args]],
  [npm, ["pack", "--ignore-scripts", "--silent", "--pack-destination", ".build/packages"]],
]) {
  const result = spawnSync(command, arguments_, { cwd: root, stdio: "inherit", shell: process.platform === "win32" && command === npm });
  if (result.error || result.status !== 0) throw result.error ?? new Error(`${command} failed`);
}
