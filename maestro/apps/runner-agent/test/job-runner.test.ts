import { describe, expect, it } from "vitest";
import { LeaseLostError } from "../src/errors.js";
import { JobRunner } from "../src/job-runner.js";
import { KillSwitchState } from "../src/kill-switch.js";
import { FakeClock, FakeRunner, leasedJob } from "./helpers.js";

/**
 * The sandbox life cycle (task #4) and kill-switch obedience (task #5).
 *
 * Every cancellation test asserts a NEGATIVE — that `runSession` was never
 * reached — because "the job reported cancelled" is also what a broken
 * implementation says after running the work to completion.
 */

interface Harness {
  runner: FakeRunner;
  killSwitch: KillSwitchState;
  clock: FakeClock;
  logs: { stream: string; text: string }[];
  jobRunner: JobRunner;
}

function harness(options: { checkLease?: (leaseId: string) => Promise<void> } = {}): Harness {
  const runner = new FakeRunner();
  const killSwitch = new KillSwitchState();
  const clock = new FakeClock();
  const logs: { stream: string; text: string }[] = [];
  const jobRunner = new JobRunner({
    runner,
    killSwitch,
    platform: "macos-xcode",
    now: clock.now,
    agentToken: "s3cr3t-token-value-abcdefghijkl",
    logSink: async (chunk) => {
      logs.push(chunk);
      await Promise.resolve();
    },
    ...(options.checkLease === undefined ? {} : { checkLease: options.checkLease }),
  });
  return { runner, killSwitch, clock, logs, jobRunner };
}

describe("JobRunner — sandbox life cycle", () => {
  it("acquires, runs and ALWAYS releases the sandbox on the happy path", async () => {
    const h = harness();
    const outcome = await h.jobRunner.run(leasedJob());

    expect(outcome.outcome).toBe("succeeded");
    expect(outcome.exitCode).toBe(0);
    expect(h.runner.sessions).toHaveLength(1);
    expect(h.runner.released).toEqual(["sandbox-1"]);
  });

  it("releases the sandbox when the session THROWS (no leaked sandbox)", async () => {
    const h = harness();
    h.runner.sessionError = new Error("docker daemon died");

    const outcome = await h.jobRunner.run(leasedJob());

    expect(outcome.outcome).toBe("failed");
    // The whole point: the sandbox was still torn down.
    expect(h.runner.released).toEqual(["sandbox-1"]);
  });

  it("does not mask the outcome when release itself fails", async () => {
    const h = harness();
    h.runner.releaseError = new Error("remove failed");

    const outcome = await h.jobRunner.run(leasedJob());

    // The job succeeded; a failing teardown must not rewrite that.
    expect(outcome.outcome).toBe("succeeded");
    expect(h.runner.released).toEqual(["sandbox-1"]);
  });

  it("reports a failed job — not a throw — when no sandbox can be acquired", async () => {
    const h = harness();
    h.runner.acquireError = new Error("no capacity");

    const outcome = await h.jobRunner.run(leasedJob());

    expect(outcome.outcome).toBe("failed");
    expect(outcome.reasonKey).toBe("runner_agent.sandbox_acquire_failed");
    expect(h.runner.released).toEqual([]);
  });

  it("maps a non-zero exit code to a failed job", async () => {
    const h = harness();
    h.runner.result = { exitCode: 1, stdoutTail: "", stderrTail: "boom", durationMs: 9 };

    const outcome = await h.jobRunner.run(leasedJob());

    expect(outcome.outcome).toBe("failed");
    expect(outcome.exitCode).toBe(1);
  });
});

describe("JobRunner — kill switch (task #5)", () => {
  it("stop_all BEFORE the job starts: the sandbox is never acquired", async () => {
    const h = harness();
    h.killSwitch.apply("stop_all");

    const outcome = await h.jobRunner.run(leasedJob());

    expect(outcome.outcome).toBe("cancelled");
    expect(outcome.stoppedAt).toBe("acquire");
    // The negative assertion that makes this test mean something.
    expect(h.runner.acquired).toEqual([]);
    expect(h.runner.sessions).toEqual([]);
  });

  it("stop_all flipped while the sandbox is held: runSession is never reached", async () => {
    const h = harness({
      // The step boundary between "sandbox acquired" and "work started".
      checkLease: async () => {
        h.killSwitch.apply("stop_all");
        await Promise.resolve();
      },
    });

    const outcome = await h.jobRunner.run(leasedJob());

    expect(outcome.outcome).toBe("cancelled");
    expect(h.runner.acquired).toHaveLength(1);
    expect(h.runner.sessions).toEqual([]);
    // Still released: a cancelled job must not leak its sandbox either.
    expect(h.runner.released).toEqual(["sandbox-1"]);
  });

  it("pause_intake does NOT stop a job that is already running", async () => {
    const h = harness();
    h.killSwitch.apply("pause_intake");

    const outcome = await h.jobRunner.run(leasedJob());

    expect(outcome.outcome).toBe("succeeded");
    expect(h.runner.sessions).toHaveLength(1);
  });

  it("stop_all raised DURING the session aborts the tracked job", async () => {
    const h = harness();
    h.runner.onSession = () => {
      h.killSwitch.apply("stop_all");
    };

    const outcome = await h.jobRunner.run(leasedJob());

    // The session had already been handed to the sandbox, so it ran; the agent
    // refuses to report it as a success and tears the sandbox down.
    expect(outcome.outcome).toBe("cancelled");
    expect(outcome.stoppedAt).toBe("collect");
    expect(h.runner.released).toEqual(["sandbox-1"]);
  });

  it("a job registered while stop_all is already down is aborted immediately", () => {
    const killSwitch = new KillSwitchState();
    killSwitch.apply("stop_all");
    const reasons: string[] = [];

    killSwitch.track({ abort: (reason) => reasons.push(reason) });

    expect(reasons).toEqual(["kill_switch_stop_all"]);
  });

  it("untracking a finished job keeps the running set from growing", () => {
    const killSwitch = new KillSwitchState();
    const untrack = killSwitch.track({ abort: () => undefined });
    expect(killSwitch.runningCount).toBe(1);
    untrack();
    expect(killSwitch.runningCount).toBe(0);
  });
});

describe("JobRunner — lease loss (task #3)", () => {
  it("stops before running when the lease is no longer ours", async () => {
    const h = harness({
      checkLease: (leaseId) => Promise.reject(new LeaseLostError(leaseId, "revoked")),
    });

    const outcome = await h.jobRunner.run(leasedJob());

    expect(outcome.outcome).toBe("cancelled");
    expect(outcome.reasonKey).toBe("runner_agent.cancelled_lease_lost");
    // A double-run is exactly what this prevents.
    expect(h.runner.sessions).toEqual([]);
    expect(h.runner.released).toEqual(["sandbox-1"]);
  });
});

describe("JobRunner — masked log streaming (task #6)", () => {
  it("never streams the agent token, even when the job echoes it", async () => {
    const h = harness();
    const token = "s3cr3t-token-value-abcdefghijkl";
    h.runner.result = {
      exitCode: 0,
      stdoutTail: `authorization: Bearer ${token}`,
      stderrTail: "",
      durationMs: 3,
    };

    await h.jobRunner.run(leasedJob());

    const streamed = h.logs.map((entry) => entry.text).join("\n");
    expect(streamed).not.toContain(token);
    expect(streamed).toContain("[REDACTED]");
  });

  it("never streams a secret carried in the job environment", async () => {
    const h = harness();
    const password = "hunter2-hunter2-hunter2";
    h.runner.result = {
      exitCode: 1,
      stdoutTail: "",
      stderrTail: `fatal: could not authenticate with ${password}`,
      durationMs: 3,
    };

    await h.jobRunner.run(leasedJob({ env: { GIT_PASSWORD: password } }));

    const streamed = h.logs.map((entry) => entry.text).join("\n");
    expect(streamed).not.toContain(password);
    expect(streamed).toContain("[REDACTED]");
  });

  it("a failing log sink does not fail the job", async () => {
    const runner = new FakeRunner();
    runner.result = { exitCode: 0, stdoutTail: "hello", stderrTail: "", durationMs: 1 };
    const jobRunner = new JobRunner({
      runner,
      killSwitch: new KillSwitchState(),
      platform: "macos-xcode",
      now: new FakeClock().now,
      agentToken: "a".repeat(32),
      logSink: () => Promise.reject(new Error("platform unreachable")),
    });

    const outcome = await jobRunner.run(leasedJob());

    expect(outcome.outcome).toBe("succeeded");
    expect(runner.released).toEqual(["sandbox-1"]);
  });
});
