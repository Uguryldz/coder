import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LocalVerificationRunner, LocalWorkspaceProbe, runLocal, TRUNCATED_EXIT_CODE } from "../src/index.js";

async function gitRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "maestro-local-"));
  const git = (...args: string[]) =>
    runLocal({ cwd: root, command: ["git", ...args], timeoutMs: 20_000, tailLimitBytes: 0 });
  await git("init", "-q");
  await git("config", "user.email", "t@t");
  await git("config", "user.name", "t");
  await writeFile(join(root, "a.txt"), "one\n");
  await git("add", ".");
  await git("commit", "-q", "-m", "init");
  return root;
}

describe("runLocal", () => {
  it("captures exit code and output without a shell", async () => {
    const r = await runLocal({ cwd: tmpdir(), command: ["sh", "-c", "echo out; echo err >&2; exit 3"], timeoutMs: 5000, tailLimitBytes: 0 });
    expect(r).toMatchObject({ exitCode: 3, stdoutTail: "out\n", stderrTail: "err\n", timedOut: false });
  });

  it("kills a command that outlives its timeout and says so", async () => {
    const r = await runLocal({ cwd: tmpdir(), command: ["sleep", "5"], timeoutMs: 200, tailLimitBytes: 0 });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBe(124);
    expect(r.stderrTail).toContain("timed out");
  });

  it("reports a missing executable as exit 127, not a crash", async () => {
    const r = await runLocal({ cwd: tmpdir(), command: ["definitely-not-a-binary-xyz"], timeoutMs: 5000, tailLimitBytes: 0 });
    expect(r.exitCode).toBe(127);
  });

  it("keeps the tail of long output", async () => {
    const r = await runLocal({ cwd: tmpdir(), command: ["sh", "-c", "i=0; while [ $i -lt 2000 ]; do echo line$i; i=$((i+1)); done"], timeoutMs: 5000, tailLimitBytes: 64 });
    expect(Buffer.byteLength(r.stdoutTail)).toBeLessThanOrEqual(64);
    expect(r.stdoutTail.trimEnd().endsWith("line1999")).toBe(true);
  });

  it("refuses to start when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runLocal({ cwd: tmpdir(), command: ["true"], timeoutMs: 1000, tailLimitBytes: 0, signal: controller.signal })).rejects.toThrow(/aborted/);
  });
});

describe("LocalWorkspaceProbe", () => {
  it("sees modified, added and untracked files with counts", async () => {
    const root = await gitRepo();
    await writeFile(join(root, "a.txt"), "one\ntwo\n");
    await writeFile(join(root, "b.txt"), "new\n");
    const probe = new LocalWorkspaceProbe({ runId: "r1" });
    const changed = await probe.changedFiles(root);
    expect(changed.map((c) => `${c.path}:${c.status}`).sort()).toEqual(["a.txt:modified", "b.txt:added"]);
    expect(changed.find((c) => c.path === "a.txt")?.insertions).toBe(1);
  });

  it("returns nothing for a clean tree and lists .git internals", async () => {
    const root = await gitRepo();
    const probe = new LocalWorkspaceProbe({ runId: "r1" });
    expect(await probe.changedFiles(root)).toEqual([]);
    const internals = await probe.internalChangedFiles(root);
    expect(internals.some((c) => c.path === ".git/HEAD")).toBe(true);
  });

  it("names the failing git call when the directory is not a repository", async () => {
    const probe = new LocalWorkspaceProbe({ runId: "r1" });
    await expect(probe.changedFiles(await mkdtemp(join(tmpdir(), "maestro-nogit-")))).rejects.toThrow(/git status exited/);
  });
});

describe("LocalVerificationRunner", () => {
  it("runs the spec in the workspace and returns the result", async () => {
    const root = await gitRepo();
    const runner = new LocalVerificationRunner({ runId: "r1", timeoutSeconds: 10, tailLimitBytes: 4096 });
    const r = await runner.run(root, { name: "ls", command: ["ls"] });
    expect(r.exitCode).toBe(0);
    expect(r.stdoutTail).toContain("a.txt");
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("marks output that hits the tail budget as not-a-pass", async () => {
    const runner = new LocalVerificationRunner({ runId: "r1", timeoutSeconds: 10, tailLimitBytes: 32 });
    const r = await runner.run(tmpdir(), { name: "noisy", command: ["sh", "-c", "yes | head -c 200"] });
    expect(r.exitCode).toBe(TRUNCATED_EXIT_CODE);
    expect(r.stderrTail).toContain("truncated");
  });
});
