import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RunnerError, PROTOCOL_VERSION } from "./protocol.js";
import type { RunnerOptions } from "./service.js";

export function runnerPath(options: RunnerOptions): string {
  const override = options.runnerPath ?? process.env.AGENT_KIT_RUNNER;
  if (override !== undefined) {
    if (!override.trim() || override.includes("\0")) throw new RunnerError("INVALID_CONFIG", "runnerPath must be non-empty");
    return override;
  }
  const root = new URL("../../../", import.meta.url);
  const executable = `runtime-runner${process.platform === "win32" ? ".exe" : ""}`;
  const target = `${process.platform}-${process.arch}`;
  const development = new URL(`.build/${executable}`, root);
  if (existsSync(development)) return fileURLToPath(development);
  const manifestPath = new URL("binaries/manifest.json", root);
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { version?: unknown; protocolVersion?: unknown; targets?: unknown };
    const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as { version: string };
    if (manifest.version !== pkg.version || manifest.protocolVersion !== PROTOCOL_VERSION || !Array.isArray(manifest.targets)) {
      throw new RunnerError("INVALID_PACKAGE", "Bundled binaries do not match this package version or protocol");
    }
    if (!manifest.targets.includes(target)) throw new RunnerError("UNSUPPORTED_PLATFORM", `No bundled runner for ${target}; provide runnerPath`);
    const bundled = new URL(`binaries/${target}/${executable}`, root);
    if (!existsSync(bundled)) throw new RunnerError("INVALID_PACKAGE", `Missing bundled runner for ${target}`);
    return fileURLToPath(bundled);
  }
  return fileURLToPath(development);
}

export function runnerArgs(options: RunnerOptions): string[] {
  const args = [...(options.args ?? [])];
  if (options.configPath !== undefined && options.environments !== undefined) {
    throw new RunnerError("INVALID_CONFIG", "configPath and environments cannot be combined");
  }
  if (options.configPath === undefined && options.environments === undefined) return args;
  const reserved = new Set(["--config", "--environments-json", "--cwd", "--bash", "--remote-endpoint", "--remote-target"]);
  if (args.some((arg) => reserved.has(arg.split("=")[0]!))) throw new RunnerError("INVALID_CONFIG", "Named environments cannot be combined with environment flags in args");
  if (options.configPath !== undefined) {
    if (!options.configPath.trim() || options.configPath.includes("\0")) throw new RunnerError("INVALID_CONFIG", "configPath must be non-empty");
    return [...args, "--config", options.configPath];
  }
  const document = JSON.stringify({ version: 1, environments: options.environments });
  if (Buffer.byteLength(document) > 64 * 1024) throw new RunnerError("INVALID_CONFIG", "Environment configuration exceeds 64 KiB");
  return [...args, "--environments-json", document];
}
