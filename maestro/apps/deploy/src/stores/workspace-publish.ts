import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PublishWorkspaceResult } from "@maestro/ports";
import { caEnv, WorkspaceError } from "./workspace-prepare.js";

const run = promisify(execFile);

export interface PublishRequest {
  readonly workspacePath: string;
  /** SCM host (github.com, dev.azure.com, an on-prem server). */
  readonly host: string;
  /** Clone path form: `owner/repo` or `project/_git/repo`. */
  readonly appId: string;
  readonly branch: string;
  readonly message: string;
  readonly token: string | undefined;
  readonly credential: "short_lived" | "connection";
  readonly author?: { readonly name: string; readonly email: string };
  readonly timeoutMs?: number;
  /** Overrides the `https://<host>/<appId>.git` form (tests push to a local bare repo). */
  readonly remoteUrl?: string;
}

/** Branches Maestro owns outright; a stale one from an earlier run may be replaced. */
export const MAESTRO_BRANCH_PREFIX = "maestro/";

/**
 * Commit the clone's working tree and push it to the real remote.
 *
 * The clone's `origin` is the pool mirror (`file://`), never the server, so
 * the push names the HTTPS URL explicitly; the mirror learns about the new
 * branch on its next fetch. The token rides in an `http.<host>/.extraheader`
 * passed with `-c` — process-local, never in `.git/config`, never on argv as
 * a URL (a PAT in `ps` output is a PAT in an incident report).
 *
 * Basic with `x-access-token` as the user: what GitHub and ADO both accept
 * for a PAT; `Bearer` makes git fall back to prompting for a username.
 *
 * Only Maestro's own `maestro/…` branches are force-pushed, and only after a
 * plain push was rejected as non-fast-forward: a stale branch from an
 * abandoned run on the same ticket is Maestro's to replace, anyone else's
 * branch is not.
 */
export async function publishWorkspace(request: PublishRequest): Promise<PublishWorkspaceResult> {
  const { workspacePath, branch } = request;
  const timeout = request.timeoutMs ?? 180_000;
  const env = { ...gitEnv(), ...caEnv() };
  const git = (args: readonly string[]) =>
    run("git", ["-C", workspacePath, ...args], { timeout, env, maxBuffer: 8 * 1024 * 1024 });

  const status = (await git(["status", "--porcelain=v1", "-z", "-uall"])).stdout;
  const dirty = status.split("\0").filter((line) => line.trim() !== "" && !line.endsWith(".maestro-workspace"));
  const ahead = await commitsAhead(git);
  if (dirty.length === 0 && ahead === 0) return { pushed: false, reason: "no_changes" };

  await git(["checkout", "-q", "-B", branch]);
  if (dirty.length > 0) {
    // The marker file the probe dates changes against is Maestro's, not the repo's.
    await git(["add", "-A", "--", ".", ":(exclude).maestro-workspace"]);
    const author = request.author ?? { name: "Maestro", email: "maestro@noreply.local" };
    await git([
      "-c",
      `user.name=${author.name}`,
      "-c",
      `user.email=${author.email}`,
      "commit",
      "-q",
      "--no-verify",
      "-m",
      request.message,
    ]);
  }
  const files = (await git(["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"])).stdout
    .split("\n")
    .filter((line) => line.trim() !== "").length;
  const sha = (await git(["rev-parse", "HEAD"])).stdout.trim();

  const url = request.remoteUrl ?? `https://${request.host}/${request.appId}.git`;
  const auth = authArgs(request.host, request.token);
  const refspec = `HEAD:refs/heads/${branch}`;
  try {
    await run("git", [...auth, "-C", workspacePath, "push", "-q", url, refspec], { timeout, env });
  } catch (cause) {
    const text = describe(cause);
    const nonFastForward = /rejected|non-fast-forward|fetch first|failed to push some refs/i.test(text);
    if (!nonFastForward || !branch.startsWith(MAESTRO_BRANCH_PREFIX)) {
      throw new WorkspaceError(`push of ${branch} to ${request.appId} failed: ${redact(text, request.token)}`, cause);
    }
    try {
      await run("git", [...auth, "-C", workspacePath, "push", "-q", "--force", url, refspec], { timeout, env });
    } catch (again) {
      throw new WorkspaceError(
        `force push of ${branch} to ${request.appId} failed: ${redact(describe(again), request.token)}`,
        again,
      );
    }
  }
  return { pushed: true, sha, files, credential: request.credential };
}

async function commitsAhead(git: (args: readonly string[]) => Promise<{ stdout: string }>): Promise<number> {
  // The clone is shallow and single-branch; `@{upstream}` exists when the
  // clone tracked a branch. Without one there is nothing to be ahead of.
  try {
    const out = (await git(["rev-list", "--count", "@{upstream}..HEAD"])).stdout.trim();
    return Number(out) || 0;
  } catch {
    return 0;
  }
}

function authArgs(host: string, token: string | undefined): string[] {
  if (token === undefined || token.trim() === "") return [];
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return ["-c", `http.https://${host}/.extraheader=Authorization: Basic ${basic}`];
}

function gitEnv(): Record<string, string> {
  return {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    HOME: process.env["HOME"] ?? "/tmp",
    GIT_TERMINAL_PROMPT: "0",
    ...(process.env["HTTPS_PROXY"] === undefined ? {} : { HTTPS_PROXY: process.env["HTTPS_PROXY"] }),
    ...(process.env["NO_PROXY"] === undefined ? {} : { NO_PROXY: process.env["NO_PROXY"] }),
  };
}

function describe(error: unknown): string {
  if (error !== null && typeof error === "object") {
    const e = error as { stderr?: unknown; message?: unknown };
    if (typeof e.stderr === "string" && e.stderr.trim() !== "") return e.stderr.trim();
    if (typeof e.message === "string") return e.message;
  }
  return String(error);
}

function redact(text: string, token: string | undefined): string {
  if (token === undefined || token === "") return text;
  return text.split(token).join("***");
}
