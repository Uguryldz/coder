import { describe, expect, it } from "vitest";
import {
  buildGitPushPlan,
  createWorkspace,
  GitStepError,
  type ExecRequest,
  type ExecResult,
  type GitPushArgs,
} from "../src/workspace.js";

/**
 * OFFLINE unit tests for the github push path. Nothing shells out: a stubbed
 * exec runner records every command. The point is the SEQUENCE
 * (clone→branch→add→commit→push→rev-parse), that the token is fed to git ONLY
 * through the environment (never on an argv, never in the remote URL), and that
 * a non-zero git step fails CLOSED.
 */

const PUSH_ARGS: GitPushArgs = {
  remoteUrl: "https://github.com/ugurbank/ugurpay.git",
  branch: "feature/OPS-6",
  baseBranch: "main",
  commitSubject: "[AI] OPS-6 makbuz modülü",
  coAuthor: "Co-Authored-By: Maestro <maestro@ugurbank.example>",
  token: "ghs-super-secret-token-value",
  authorName: "Maestro AI",
  authorEmail: "maestro@ugurbank.example",
};

/** Records exec requests and replies OK (or a scripted failure at one step). */
function recordingExec(failAt?: (req: ExecRequest) => boolean): {
  exec: (req: ExecRequest) => Promise<ExecResult>;
  calls: ExecRequest[];
} {
  const calls: ExecRequest[] = [];
  const exec = (req: ExecRequest): Promise<ExecResult> => {
    calls.push(req);
    if (failAt?.(req)) {
      return Promise.resolve({ ok: false, exitCode: 1, stdout: "", stderr: "boom" });
    }
    const isRevParse = req.args[0] === "rev-parse";
    return Promise.resolve({
      ok: true,
      exitCode: 0,
      stdout: isRevParse ? "abc123def456abc123def456abc123def456abcd\n" : "",
      stderr: "",
    });
  };
  return { exec, calls };
}

describe("buildGitPushPlan", () => {
  it("emits clone→branch→add→commit→push→rev-parse in order", () => {
    const plan = buildGitPushPlan(PUSH_ARGS);
    const verbs = plan.steps.map((s) => s.args[0]);
    expect(verbs).toEqual(["clone", "checkout", "add", "commit", "push", "rev-parse"]);
  });

  it("never puts --force on the push (no force-push, M13)", () => {
    const plan = buildGitPushPlan(PUSH_ARGS);
    const push = plan.steps.find((s) => s.args[0] === "push");
    expect(push?.args).toEqual(["push", "origin", "feature/OPS-6"]);
    expect(plan.steps.some((s) => s.args.includes("--force") || s.args.includes("-f"))).toBe(false);
  });

  it("carries the token ONLY in the credential env, never on any argv or the remote", () => {
    const plan = buildGitPushPlan(PUSH_ARGS);
    const everyArg = plan.steps.flatMap((s) => s.args).join(" ");
    expect(everyArg).not.toContain(PUSH_ARGS.token);
    // The remote URL is credential-free.
    expect(everyArg).toContain("https://github.com/ugurbank/ugurpay.git");
    expect(everyArg).not.toContain("@github.com");
    // The token rides an ephemeral http.extraHeader in GIT_CONFIG_VALUE_0.
    expect(plan.credentialEnv["GIT_CONFIG_COUNT"]).toBe("3");
    expect(plan.credentialEnv["GIT_CONFIG_KEY_0"]).toBe("http.extraHeader");
    const header = plan.credentialEnv["GIT_CONFIG_VALUE_0"] ?? "";
    expect(header.toLowerCase()).toContain("authorization: basic ");
    // The token is base64'd inside the header; decoding proves it's there, but
    // only in the env value, nowhere on argv.
    const b64 = header.split(" ").pop() ?? "";
    expect(Buffer.from(b64, "base64").toString("utf8")).toContain(PUSH_ARGS.token);
    expect(plan.credentialEnv["GIT_TERMINAL_PROMPT"]).toBe("0");
  });

  it("commit message carries the [AI] subject and the Co-Authored-By trailer (M13)", () => {
    const plan = buildGitPushPlan(PUSH_ARGS);
    const commit = plan.steps.find((s) => s.args[0] === "commit");
    const message = commit?.args[commit.args.indexOf("-m") + 1] ?? "";
    expect(message).toContain("[AI] OPS-6");
    expect(message).toContain("Co-Authored-By: Maestro");
  });
});

describe("workspace.gitPush", () => {
  it("runs the sequence over the injected exec and returns the pushed sha", async () => {
    const { exec, calls } = recordingExec();
    const ws = await createWorkspace({ exec });
    try {
      const result = await ws.gitPush(PUSH_ARGS);
      expect(result.commitSha).toBe("abc123def456abc123def456abc123def456abcd");
      expect(calls.map((c) => c.args[0])).toEqual([
        "clone",
        "checkout",
        "add",
        "commit",
        "push",
        "rev-parse",
      ]);
      // Every git child got the credential env (token only in env, never argv).
      for (const call of calls) {
        expect(call.file).toBe("git");
        expect(call.env?.["GIT_CONFIG_KEY_0"]).toBe("http.extraHeader");
        expect(call.args.join(" ")).not.toContain(PUSH_ARGS.token);
      }
    } finally {
      await ws.dispose();
    }
  });

  it("clones into the repo dir at root, then runs the rest inside it", async () => {
    const { exec, calls } = recordingExec();
    const ws = await createWorkspace({ exec });
    try {
      await ws.gitPush(PUSH_ARGS);
      const clone = calls[0]!;
      expect(clone.cwd).toBe(ws.root);
      // Subsequent steps run inside <root>/repo.
      for (const call of calls.slice(1)) {
        expect(call.cwd).toBe(`${ws.root}/repo`);
      }
    } finally {
      await ws.dispose();
    }
  });

  it("fails CLOSED when the push step exits non-zero (no false success)", async () => {
    const { exec, calls } = recordingExec((req) => req.args[0] === "push");
    const ws = await createWorkspace({ exec });
    try {
      await expect(ws.gitPush(PUSH_ARGS)).rejects.toBeInstanceOf(GitStepError);
      // rev-parse never ran — the sequence stopped at the failed push.
      expect(calls.map((c) => c.args[0])).toEqual(["clone", "checkout", "add", "commit", "push"]);
    } finally {
      await ws.dispose();
    }
  });

  it("the GitStepError message carries the argv + stderr but NOT the token", async () => {
    const { exec } = recordingExec((req) => req.args[0] === "clone");
    const ws = await createWorkspace({ exec });
    try {
      const error = await ws.gitPush(PUSH_ARGS).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(GitStepError);
      const message = (error as GitStepError).message;
      expect(message).toContain("clone");
      expect(message).toContain("boom");
      expect(message).not.toContain(PUSH_ARGS.token);
    } finally {
      await ws.dispose();
    }
  });
});
