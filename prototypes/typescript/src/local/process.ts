import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { checkCancelled, RuntimeError } from "../errors.js";
import type { CommandRequest, CommandResult } from "../types.js";

export async function runLocalCommand(
  request: CommandRequest, defaultCwd: string, shell: string,
): Promise<CommandResult> {
  checkCancelled(request.signal);
  const startedAt = performance.now();
  return new Promise((resolveResult, reject) => {
    const child = spawn(shell, ["-c", request.command], {
      cwd: resolve(defaultCwd, request.cwd ?? "."),
      env: { ...process.env, ...request.env },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
    let retainedBytes = 0;
    let truncated = false;
    let failure: RuntimeError | undefined;

    const kill = () => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const terminate = (error: RuntimeError) => {
      failure ??= error;
      kill();
    };
    const onAbort = () => terminate(new RuntimeError("CANCELLED", "Command cancelled", request.signal?.reason));
    const timeout = setTimeout(
      () => terminate(new RuntimeError("TIMEOUT", `Command exceeded ${request.timeoutMs} ms`)),
      request.timeoutMs,
    );
    const emit = (stream: "stdout" | "stderr", data: string) => {
      if (!data || failure) return;
      try {
        request.onOutput?.({ stream, data });
      } catch (error) {
        terminate(new RuntimeError("EXECUTION_FAILED", "Output callback failed", error));
      }
    };
    const collect = (stream: "stdout" | "stderr", chunk: Buffer) => {
      const retained = Math.min(chunk.length, request.maxOutputBytes - retainedBytes);
      if (retained > 0) {
        (stream === "stdout" ? stdout : stderr).push(Buffer.from(chunk.subarray(0, retained)));
        retainedBytes += retained;
      }
      if (retained < chunk.length) truncated = true;
      emit(stream, decoders[stream].write(chunk));
    };
    child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk));
    child.on("error", (error) => {
      failure ??= new RuntimeError("EXECUTION_FAILED", error.message, error);
    });
    // Commands are one-shot. Descendants in this process group share its lifetime.
    child.once("exit", kill);
    child.once("close", (exitCode, signal) => {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", onAbort);
      emit("stdout", decoders.stdout.end());
      emit("stderr", decoders.stderr.end());
      if (failure) return reject(failure);
      resolveResult({
        exitCode, signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        truncated,
        durationMs: Math.round(performance.now() - startedAt),
      });
    });
    request.signal?.addEventListener("abort", onAbort, { once: true });
    if (request.signal?.aborted) onAbort();
  });
}
