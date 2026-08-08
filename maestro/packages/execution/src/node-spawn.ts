import { spawn } from "node:child_process";
import type { SpawnFn, SpawnResult } from "./types.js";

/**
 * The one impure adapter here: `SpawnFn` over `node:child_process`. It is
 * generic (it knows nothing about `claude`) so the runner's tests inject a
 * double and stay offline, while production still has a real implementation
 * instead of an interface nobody fills. `shell` is never used — arguments go as
 * an array, so a task or a path can never be re-interpreted by a shell.
 */
export function nodeSpawn(): SpawnFn {
  return (spec) =>
    new Promise<SpawnResult>((resolve, reject) => {
      const child = spawn(spec.command, [...spec.args], {
        cwd: spec.cwd,
        env: { ...spec.env },
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
      });

      let stdout = "";
      let stderr = "";
      let pending = "";
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, spec.timeoutMs);

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (!spec.onStdoutLine) return;
        pending += chunk;
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) if (line.trim() !== "") spec.onStdoutLine(line);
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (spec.onStdoutLine && pending.trim() !== "") spec.onStdoutLine(pending);
        resolve({ exitCode: code ?? -1, stdout, stderr, timedOut });
      });

      child.stdin.end(spec.stdin);
    });
}
