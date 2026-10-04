import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { MAESTRO_BRANCH_PREFIX, publishWorkspace } from "../src/stores/workspace-publish.js";

const run = promisify(execFile);
const git = (cwd: string, ...args: string[]) => run("git", ["-C", cwd, ...args]);

/** A bare "server" repo with one commit on main, and a shallow clone of it as the run's workspace. */
async function fixture(): Promise<{ remote: string; clone: string }> {
  const base = await mkdtemp(join(tmpdir(), "maestro-publish-"));
  const seed = join(base, "seed");
  await run("git", ["init", "-q", "-b", "main", seed]);
  await git(seed, "config", "user.email", "t@t");
  await git(seed, "config", "user.name", "t");
  await writeFile(join(seed, "README.md"), "# demo\n");
  await git(seed, "add", ".");
  await git(seed, "commit", "-q", "-m", "init");
  const remote = join(base, "remote.git");
  await run("git", ["clone", "-q", "--bare", seed, remote]);
  const clone = join(base, "clone");
  await run("git", ["clone", "-q", "--depth", "1", "--single-branch", `file://${remote}`, clone]);
  await writeFile(join(clone, ".maestro-workspace"), "marker\n");
  return { remote, clone };
}

describe("publishWorkspace", () => {
  it("reports no_changes for a clean clone and pushes nothing", async () => {
    const { remote, clone } = await fixture();
    const out = await publishWorkspace({
      workspacePath: clone, host: "example.invalid", appId: "o/r", branch: "maestro/pay-1",
      message: "PAY-1: x", token: undefined, credential: "connection", remoteUrl: `file://${remote}`,
    });
    expect(out).toEqual({ pushed: false, reason: "no_changes" });
    const refs = (await git(remote, "branch", "--list")).stdout;
    expect(refs).not.toContain("maestro/pay-1");
  });

  it("commits the working tree (without Maestro's marker) and pushes the feature branch", async () => {
    const { remote, clone } = await fixture();
    await writeFile(join(clone, "src.ts"), "export const a = 1;\n");
    await writeFile(join(clone, "README.md"), "# demo\nchanged\n");
    const out = await publishWorkspace({
      workspacePath: clone, host: "example.invalid", appId: "o/r", branch: "maestro/pay-1",
      message: "PAY-1: değişiklik", token: "secret-token", credential: "short_lived", remoteUrl: `file://${remote}`,
    });
    expect(out.pushed).toBe(true);
    if (!out.pushed) return;
    expect(out.files).toBe(2);
    expect(out.credential).toBe("short_lived");
    const remoteSha = (await git(remote, "rev-parse", "refs/heads/maestro/pay-1")).stdout.trim();
    expect(remoteSha).toBe(out.sha);
    const tracked = (await git(remote, "ls-tree", "--name-only", "-r", "maestro/pay-1")).stdout;
    expect(tracked).toContain("src.ts");
    expect(tracked).not.toContain(".maestro-workspace");
    const subject = (await git(remote, "log", "-1", "--format=%s", "maestro/pay-1")).stdout.trim();
    expect(subject).toBe("PAY-1: değişiklik");
    // The token never lands in the clone's config.
    const config = (await git(clone, "config", "--list")).stdout;
    expect(config).not.toContain("secret-token");
  });

  it("replaces a stale branch of its own but never someone else's", async () => {
    const { remote, clone } = await fixture();
    // A previous run left a diverging maestro/ branch on the server.
    const other = await mkdtemp(join(tmpdir(), "maestro-other-"));
    await run("git", ["clone", "-q", `file://${remote}`, other]);
    await git(other, "config", "user.email", "t@t");
    await git(other, "config", "user.name", "t");
    await git(other, "checkout", "-q", "-b", `${MAESTRO_BRANCH_PREFIX}pay-1`);
    await writeFile(join(other, "stale.txt"), "old\n");
    await git(other, "add", ".");
    await git(other, "commit", "-q", "-m", "stale");
    await git(other, "push", "-q", "origin", `${MAESTRO_BRANCH_PREFIX}pay-1`);
    await git(other, "checkout", "-q", "-b", "feature/human");
    await writeFile(join(other, "human.txt"), "mine\n");
    await git(other, "add", ".");
    await git(other, "commit", "-q", "-m", "human");
    await git(other, "push", "-q", "origin", "feature/human");

    await writeFile(join(clone, "new.ts"), "export {};\n");
    const own = await publishWorkspace({
      workspacePath: clone, host: "h", appId: "o/r", branch: `${MAESTRO_BRANCH_PREFIX}pay-1`,
      message: "PAY-1: redo", token: undefined, credential: "connection", remoteUrl: `file://${remote}`,
    });
    expect(own.pushed).toBe(true);
    const tracked = (await git(remote, "ls-tree", "--name-only", "-r", `${MAESTRO_BRANCH_PREFIX}pay-1`)).stdout;
    expect(tracked).toContain("new.ts");
    expect(tracked).not.toContain("stale.txt");

    await writeFile(join(clone, "again.ts"), "export {};\n");
    await expect(
      publishWorkspace({
        workspacePath: clone, host: "h", appId: "o/r", branch: "feature/human",
        message: "PAY-1: hijack", token: undefined, credential: "connection", remoteUrl: `file://${remote}`,
      }),
    ).rejects.toThrow(/push of feature\/human/);
    const human = (await git(remote, "ls-tree", "--name-only", "-r", "feature/human")).stdout;
    expect(human).toContain("human.txt");
    expect(human).not.toContain("again.ts");
  });
});
