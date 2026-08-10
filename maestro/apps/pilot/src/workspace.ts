import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * The demo's stand-in for the hardened sandbox (M25/M60 — a real container
 * pool arrives in wave 2). It is deliberately small and honest: the generated
 * files are written to a throwaway temp directory and the generated test is
 * executed with the plain Node binary. Nothing is mounted, nothing is cached,
 * and the process inherits NO environment, so the OpenRouter key cannot leak
 * into it.
 *
 * Dalga C2 adds a REAL git path (`gitPush`) used ONLY when PILOT_SCM=github:
 * clone → branch → commit → push, over an INJECTED exec runner so tests never
 * shell out. The push credential is fed to git through GIT_CONFIG_* env vars
 * (an ephemeral `http.extraHeader`), never on the argv and never written to
 * `.git/config` — see `buildGitPushPlan`.
 */

/** Fixed paths, so the model's import specifier is predictable. */
export const IMPLEMENTATION_PATH = "src/impl.mjs";
export const TEST_PATH = "test/impl.test.mjs";

/** A single command the workspace asks the (injected) runner to execute. */
export interface ExecRequest {
  file: string;
  args: string[];
  cwd: string;
  /** Extra env for THIS child only; merged over a minimal inherited PATH. */
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface ExecResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Runs one command. Injected so tests stub it — the pilot never shells out in a test. */
export type ExecRunner = (request: ExecRequest) => Promise<ExecResult>;

export interface DemoWorkspace {
  root: string;
  write(relativePath: string, content: string): Promise<void>;
  runTest(timeoutMs?: number): Promise<TestRun>;
  /**
   * Real git sequence for the github SCM path. Returns the pushed commit sha.
   * Fails CLOSED: any non-zero git step throws, so a caller can never mistake a
   * failed push for a successful one.
   */
  gitPush(args: GitPushArgs): Promise<{ commitSha: string }>;
  dispose(): Promise<void>;
}

export interface TestRun {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface GitPushArgs {
  /** HTTPS remote WITHOUT credentials, e.g. https://github.com/owner/repo.git */
  remoteUrl: string;
  /** Feature branch to create and push, e.g. feature/OPS-6. */
  branch: string;
  /** Base branch to clone/branch from, e.g. main. */
  baseBranch: string;
  /** First line of the commit message ([AI] prefix expected, M13). */
  commitSubject: string;
  /** Trailer line, e.g. "Co-Authored-By: Maestro <maestro@…>" (M13). */
  coAuthor: string;
  /** Short-lived push token (M31). NEVER logged; fed to git via env only. */
  token: string;
  /** Author identity for the commit; the token is NOT this. */
  authorName: string;
  authorEmail: string;
}

export interface CreateWorkspaceOptions {
  /** Injected command runner; defaults to a real `execFile` sandboxed runner. */
  exec?: ExecRunner;
}

const GIT_TIMEOUT_MS = 60_000;

/**
 * Builds the ordered git command plan for a clone→branch→commit→push, plus the
 * env that carries the credential OUT of band. Pure and exported so a test can
 * assert the SEQUENCE and prove the token never lands on an argv.
 *
 * Credential handling (the security core, M31/M80):
 *  - The token is turned into a Basic `http.extraHeader` and injected through
 *    GIT_CONFIG_COUNT / GIT_CONFIG_KEY_0 / GIT_CONFIG_VALUE_0. Git applies it
 *    like a `-c` override but it is EPHEMERAL: it is never written to
 *    `.git/config`, and — unlike `-c key=value` — it is not on the argv, so it
 *    cannot surface in `ps`, a shell history, or a logged command line.
 *  - The remote URL stays credential-free, so `git remote -v` / `.git/config`
 *    hold only `https://github.com/owner/repo.git`.
 *  - The env map is returned SEPARATELY from the argv so a logger can print the
 *    argv freely and never touch the secret.
 */
export function buildGitPushPlan(args: GitPushArgs): {
  steps: Array<{ args: string[]; cwd: "parent" | "repo" }>;
  credentialEnv: Record<string, string>;
  repoDirName: string;
} {
  const repoDirName = "repo";
  const header = `AUTHORIZATION: basic ${base64(`x-access-token:${args.token}`)}`;
  // All overrides — the credential header AND the commit identity — ride
  // GIT_CONFIG_* so NONE of them land on an argv or in `.git/config`. The token
  // is the one that matters for secrecy; the identity travels the same way so a
  // logger printing the argv shows a clean `git commit -m …` with no `-c`.
  const credentialEnv: Record<string, string> = {
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: header,
    GIT_CONFIG_KEY_1: "user.name",
    GIT_CONFIG_VALUE_1: args.authorName,
    GIT_CONFIG_KEY_2: "user.email",
    GIT_CONFIG_VALUE_2: args.authorEmail,
    // Belt-and-braces: never let git pop an interactive credential prompt.
    GIT_TERMINAL_PROMPT: "0",
  };

  const message = `${args.commitSubject}\n\n${args.coAuthor}`;

  const steps: Array<{ args: string[]; cwd: "parent" | "repo" }> = [
    // clone the base branch, shallow, into ./repo
    {
      args: ["clone", "--branch", args.baseBranch, "--depth", "1", args.remoteUrl, repoDirName],
      cwd: "parent",
    },
    // branch off
    { args: ["checkout", "-b", args.branch], cwd: "repo" },
    // stage the model's files
    { args: ["add", "--all"], cwd: "repo" },
    // commit with the AI author identity (from env) + co-author trailer (M13)
    { args: ["commit", "-m", message], cwd: "repo" },
    // push the new branch; NEVER --force (protected_paths / no force-push, M13)
    { args: ["push", "origin", args.branch], cwd: "repo" },
    // resolve the pushed commit sha for the caller
    { args: ["rev-parse", "HEAD"], cwd: "repo" },
  ];
  return { steps, credentialEnv, repoDirName };
}

export async function createWorkspace(options: CreateWorkspaceOptions = {}): Promise<DemoWorkspace> {
  const root = await mkdtemp(join(tmpdir(), "maestro-demo-"));
  const exec = options.exec ?? defaultExecRunner;

  return {
    root,
    async write(relativePath: string, content: string): Promise<void> {
      const full = join(root, relativePath);
      mkdirSync(dirname(full), { recursive: true });
      await writeFile(full, content, "utf8");
    },
    runTest(timeoutMs = 20_000): Promise<TestRun> {
      const startedAt = Date.now();
      return exec({
        file: process.execPath,
        args: [TEST_PATH],
        cwd: root,
        timeoutMs,
        env: { PATH: process.env["PATH"] ?? "" },
      }).then((result) => ({
        ok: result.ok,
        exitCode: result.exitCode,
        stdout: result.stdout.trim(),
        stderr: result.stderr.trim(),
        durationMs: Date.now() - startedAt,
      }));
    },
    async gitPush(args: GitPushArgs): Promise<{ commitSha: string }> {
      const { steps, credentialEnv, repoDirName } = buildGitPushPlan(args);
      const repoDir = join(root, repoDirName);
      // The credential env rides on EVERY git child (the header is only used by
      // the transport steps, but keeping it uniform means no branch decides,
      // per command, whether to attach the secret). PATH is the only inherited
      // value; nothing else of the pilot's environment reaches git.
      const baseEnv: Record<string, string> = { PATH: process.env["PATH"] ?? "", ...credentialEnv };

      let commitSha = "";
      for (const step of steps) {
        const result = await exec({
          file: "git",
          args: step.args,
          cwd: step.cwd === "parent" ? root : repoDir,
          env: baseEnv,
          timeoutMs: GIT_TIMEOUT_MS,
        });
        if (!result.ok) {
          // Fail closed. The message carries the git argv (never the secret —
          // it lives only in env) and stderr, so the step surfaces a real cause.
          throw new GitStepError(step.args, result.exitCode, result.stderr || result.stdout);
        }
        if (step.args[0] === "rev-parse") commitSha = result.stdout.trim();
      }
      if (commitSha === "") {
        throw new GitStepError(["rev-parse", "HEAD"], null, "git push HEAD sha'sı çözülemedi");
      }
      return { commitSha };
    },
    async dispose(): Promise<void> {
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** A git step that exited non-zero. Carries argv + stderr, never the token. */
export class GitStepError extends Error {
  constructor(
    readonly gitArgs: string[],
    readonly exitCode: number | null,
    readonly detail: string,
  ) {
    super(`git ${gitArgs.join(" ")} çıkış kodu ${exitCode ?? "?"}: ${detail}`);
    this.name = "GitStepError";
  }
}

/** Real runner: `execFile` with an explicit env, no shell, no inherited env. */
function defaultExecRunner(request: ExecRequest): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve) => {
    execFile(
      request.file,
      request.args,
      {
        cwd: request.cwd,
        timeout: request.timeoutMs ?? 20_000,
        env: request.env ?? { PATH: process.env["PATH"] ?? "" },
        maxBuffer: 8 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: unknown }).code === "number"
            ? (error as { code: number }).code
            : error
              ? null
              : 0;
        resolve({
          ok: error === null,
          exitCode: code,
          stdout: String(stdout),
          stderr: String(stderr),
        });
      },
    );
  });
}

function base64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}
