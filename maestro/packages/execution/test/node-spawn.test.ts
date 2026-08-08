import { describe, expect, it } from "vitest";
import { nodeSpawn } from "../src/node-spawn.js";

/**
 * The adapter is exercised against `process.execPath` with an inline script —
 * never against the real `claude` binary: this suite must stay offline and
 * must not spend a subscription seat.
 */
const NODE = process.execPath;

function script(body: string): string[] {
  return ["-e", body];
}

describe("nodeSpawn", () => {
  it("feeds stdin, collects stdout and reports the exit code", async () => {
    const result = await nodeSpawn()({
      command: NODE,
      args: script("process.stdin.on('data',d=>process.stdout.write('got:'+d));"),
      cwd: process.cwd(),
      stdin: "hello",
      env: {},
      timeoutMs: 20_000,
    });
    expect(result.stdout).toBe("got:hello");
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it("keeps stderr and a non-zero exit apart from stdout", async () => {
    const result = await nodeSpawn()({
      command: NODE,
      args: script("process.stderr.write('bad');process.exit(3);"),
      cwd: process.cwd(),
      stdin: "",
      env: {},
      timeoutMs: 20_000,
    });
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toBe("bad");
    expect(result.stdout).toBe("");
  });

  it("delivers complete NDJSON lines as they arrive, including the last one", async () => {
    const lines: string[] = [];
    await nodeSpawn()({
      command: NODE,
      args: script("process.stdout.write('{\"a\":1}\\n{\"b\":2}');"),
      cwd: process.cwd(),
      stdin: "",
      env: {},
      timeoutMs: 20_000,
      onStdoutLine: (line) => lines.push(line),
    });
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("passes only the environment it was given", async () => {
    const result = await nodeSpawn()({
      command: NODE,
      args: script("process.stdout.write(JSON.stringify(Object.keys(process.env).sort()));"),
      cwd: process.cwd(),
      stdin: "",
      env: { MAESTRO_SEAT: "seat-1" },
      timeoutMs: 20_000,
    });
    expect(JSON.parse(result.stdout)).toEqual(["MAESTRO_SEAT"]);
  });

  it("kills a process that outstays its timeout", async () => {
    const result = await nodeSpawn()({
      command: NODE,
      args: script("setInterval(()=>{},1000);"),
      cwd: process.cwd(),
      stdin: "",
      env: {},
      timeoutMs: 250,
    });
    expect(result.timedOut).toBe(true);
  });

  it("rejects when the command does not exist instead of reporting an empty run", async () => {
    await expect(
      nodeSpawn()({
        command: "/nonexistent/maestro-claude",
        args: [],
        cwd: process.cwd(),
        stdin: "",
        env: {},
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow();
  });
});
