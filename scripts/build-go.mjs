import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const flags = new Set(process.argv.slice(2));
if ([...flags].some((flag) => !["--bundle", "--all"].includes(flag)) || flags.has("--all") && !flags.has("--bundle")) throw new Error("Use --bundle [--all]");
const config = JSON.parse(await readFile(join(root, "packaging/targets.json"), "utf8"));
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const platforms = { darwin: "darwin", linux: "linux", win32: "windows" };
const architectures = { arm64: "arm64", x64: "amd64" };
const host = `${process.platform}-${process.arch}`;
if (!Array.isArray(config.targets) || new Set(config.targets).size !== config.targets.length || !config.targets.length || !Array.isArray(config.binaries) || !config.binaries.length) throw new Error("Invalid packaging targets");
for (const target of config.targets) {
  const [platform, arch, extra] = target.split("-");
  if (!platforms[platform] || !architectures[arch] || extra) throw new Error(`Unsupported target ${target}`);
}
if (new Set(config.binaries).size !== config.binaries.length || config.binaries.some((name) => !["runtime-runner", "remote-server"].includes(name)) || !config.binaries.includes("runtime-runner")) throw new Error("Invalid binary selection");
const targets = flags.has("--all") ? config.targets : [host];
if (!config.targets.includes(host) && !flags.has("--all")) throw new Error(`Unsupported host ${host}`);
await mkdir(join(root, ".build/packages"), { recursive: true });
const staging = await mkdtemp(join(root, ".build/binaries-"));
try {
  const files = {};
  for (const target of targets) {
    const [platform, arch] = target.split("-");
    const output = flags.has("--bundle") ? join(staging, target) : staging;
    await mkdir(output, { recursive: true });
    for (const name of config.binaries) {
      const executable = `${name}${platform === "win32" ? ".exe" : ""}`;
      const path = join(output, executable);
      const result = spawnSync("go", ["build", "-trimpath", "-ldflags=-s -w", "-o", path, `./cmd/${name}`], {
        cwd: join(root, "go"), env: { ...process.env, CGO_ENABLED: "0", GOOS: platforms[platform], GOARCH: architectures[arch] }, stdio: "inherit",
      });
      if (result.error || result.status !== 0) throw result.error ?? new Error(`Go build failed: ${target}/${name}`);
      files[`${target}/${executable}`] = createHash("sha256").update(await readFile(path)).digest("hex");
    }
  }
  if (flags.has("--bundle")) {
    await writeFile(join(staging, "manifest.json"), JSON.stringify({ version: pkg.version, protocolVersion: 1, targets, sha256: files }, null, 2) + "\n");
    await rm(join(root, "binaries"), { recursive: true, force: true });
    await rename(staging, join(root, "binaries"));
  } else {
    for (const name of config.binaries) {
      const executable = `${name}${process.platform === "win32" ? ".exe" : ""}`;
      await rm(join(root, ".build", executable), { force: true });
      await rename(join(staging, executable), join(root, ".build", executable));
    }
  }
  console.log(`Built ${targets.join(", ")}`);
} finally { await rm(staging, { recursive: true, force: true }); }
