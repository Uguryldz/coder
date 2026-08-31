import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_POLL_SECONDS,
  resolveCommandIntake,
  startCommandIntake,
  type StoredCommandIntake,
  type StoppablePoller,
} from "../src/command-intake.js";

/**
 * How ticket commands reach this deployment — the setting the setup wizard
 * asks for in words, and the loop that honours it.
 *
 * The failure being tested for is not hypothetical. `/approve` written on a
 * ticket is the documented way to pass a gate, and whether it was ever READ
 * used to depend on `JIRA_POLL_MS` — an environment variable in a file on the
 * server, read once at boot. An operator approving in the only place they were
 * told to would watch the gate wait forever with nothing naming the cause.
 *
 * So the rules below are the ones that fail SILENTLY when they are wrong:
 * which source wins, what an already-running install keeps doing after the
 * upgrade, whether a driver that cannot read comments is stopped from polling,
 * and whether a saved change applies without a restart.
 */
describe("resolveCommandIntake", () => {
  it("uses webhook-only when nothing is stored and no env variable is set", () => {
    expect(resolveCommandIntake({}, undefined)).toEqual({
      mode: "webhook",
      pollSeconds: 0,
      source: "default",
    });
  });

  /**
   * The backwards-compatibility rule, and the reason it is not decorative:
   * installs running today set `JIRA_POLL_MS` and nothing else. An upgrade
   * that ignored it would stop polling them, and every gate they approve from
   * a ticket would stop closing — with no screen anywhere reporting a change.
   */
  it("keeps polling an install that only ever set JIRA_POLL_MS", () => {
    expect(resolveCommandIntake({}, "60000")).toEqual({
      mode: "poll",
      pollSeconds: 60,
      source: "env",
    });
  });

  /** Sub-second intervals round UP: flooring would silently disable the loop. */
  it("never rounds a configured env interval down to zero", () => {
    expect(resolveCommandIntake({}, "500").pollSeconds).toBe(1);
  });

  it("ignores an env variable that is not a positive number", () => {
    for (const raw of ["", "  ", "0", "-1", "abc", undefined]) {
      expect(resolveCommandIntake({}, raw).mode, String(raw)).toBe("webhook");
    }
  });

  /**
   * The precedence that makes the panel trustworthy: an answer given on a
   * screen is not quietly overridden by a deployment file.
   */
  it("lets the stored parameter beat JIRA_POLL_MS", () => {
    expect(resolveCommandIntake({ mode: "webhook" }, "60000")).toEqual({
      mode: "webhook",
      pollSeconds: 0,
      source: "param",
    });
    expect(resolveCommandIntake({ mode: "poll", pollSeconds: 90 }, "60000")).toEqual({
      mode: "poll",
      pollSeconds: 90,
      source: "param",
    });
  });

  /**
   * "Poll" with no usable interval must not become "polling is on and never
   * runs" — that is the same silent no-op the setting exists to escape.
   */
  it("falls back to the default interval rather than to zero", () => {
    for (const stored of [
      { mode: "poll" },
      { mode: "poll", pollSeconds: 0 },
      { mode: "both", pollSeconds: "60" },
    ] satisfies StoredCommandIntake[]) {
      expect(resolveCommandIntake(stored, undefined).pollSeconds).toBe(DEFAULT_POLL_SECONDS);
    }
  });

  it("ignores a stored mode that is not one of the three answers", () => {
    expect(resolveCommandIntake({ mode: "yoklama" }, undefined).source).toBe("default");
  });
});

describe("startCommandIntake", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** A poller stand-in that records how many times it was started and stopped. */
  function fakePoller(): {
    start: (intervalMs: number) => StoppablePoller;
    starts: number[];
    stops: number;
  } {
    const record = {
      starts: [] as number[],
      stops: 0,
      start: (intervalMs: number): StoppablePoller => {
        record.starts.push(intervalMs);
        return { stop: () => (record.stops += 1) };
      },
    };
    return record;
  }

  it("starts no poller for a webhook-only answer", async () => {
    const poller = fakePoller();
    const handle = startCommandIntake({
      readStored: () => Promise.resolve({ mode: "webhook" }),
      envPollMs: undefined,
      canReadComments: true,
      startPoller: poller.start,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(poller.starts).toEqual([]);
    expect(handle.status().mode).toBe("webhook");
    handle.stop();
  });

  it("starts the poller immediately, not one supervision interval later", async () => {
    const poller = fakePoller();
    const handle = startCommandIntake({
      readStored: () => Promise.resolve({ mode: "poll", pollSeconds: 45 }),
      envPollMs: undefined,
      canReadComments: true,
      startPoller: poller.start,
      superviseMs: 30_000,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(poller.starts).toEqual([45_000]);
    handle.stop();
  });

  /**
   * The promise the wizard makes to the operator: "kaydettiğiniz anda geçerli
   * olur". Without the supervisor the answer was read once at boot, so saving
   * it changed nothing until somebody restarted a container — which on a
   * bank's server is a change request, not a click.
   */
  it("starts polling when the answer changes, with no restart", async () => {
    const poller = fakePoller();
    let stored: StoredCommandIntake = { mode: "webhook" };
    const handle = startCommandIntake({
      readStored: () => Promise.resolve(stored),
      envPollMs: undefined,
      canReadComments: true,
      startPoller: poller.start,
      superviseMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(poller.starts).toEqual([]);

    stored = { mode: "poll", pollSeconds: 60 };
    await vi.advanceTimersByTimeAsync(1_000);
    expect(poller.starts).toEqual([60_000]);
    expect(handle.status().pollSeconds).toBe(60);
    handle.stop();
  });

  it("stops polling when the operator switches back to webhook-only", async () => {
    const poller = fakePoller();
    let stored: StoredCommandIntake = { mode: "poll", pollSeconds: 60 };
    const handle = startCommandIntake({
      readStored: () => Promise.resolve(stored),
      envPollMs: undefined,
      canReadComments: true,
      startPoller: poller.start,
      superviseMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(poller.starts).toHaveLength(1);

    stored = { mode: "webhook" };
    await vi.advanceTimersByTimeAsync(1_000);
    expect(poller.stops).toBe(1);
    expect(handle.status().pollSeconds).toBe(0);
    handle.stop();
  });

  it("re-intervals the poller when only the interval changes", async () => {
    const poller = fakePoller();
    let stored: StoredCommandIntake = { mode: "poll", pollSeconds: 60 };
    const handle = startCommandIntake({
      readStored: () => Promise.resolve(stored),
      envPollMs: undefined,
      canReadComments: true,
      startPoller: poller.start,
      superviseMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(0);

    stored = { mode: "poll", pollSeconds: 15 };
    await vi.advanceTimersByTimeAsync(1_000);
    expect(poller.starts).toEqual([60_000, 15_000]);
    expect(poller.stops).toBe(1);
    handle.stop();
  });

  /** An unchanged answer must not churn the loop on every supervision round. */
  it("leaves a running poller alone while nothing changes", async () => {
    const poller = fakePoller();
    const handle = startCommandIntake({
      readStored: () => Promise.resolve({ mode: "poll", pollSeconds: 60 }),
      envPollMs: undefined,
      canReadComments: true,
      startPoller: poller.start,
      superviseMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(poller.starts).toEqual([60_000]);
    expect(poller.stops).toBe(0);
    handle.stop();
  });

  /**
   * The capability rule. A driver with no `listComments` cannot poll, and
   * starting the loop anyway throws once per ticket per interval into a log
   * nobody reads — while the panel says polling is on.
   *
   * The stored answer is still REPORTED, because the wizard has to be able to
   * say "you asked for this and it cannot work here" rather than pretend the
   * operator never asked.
   */
  it("never polls on a driver that cannot read comments, whatever is stored", async () => {
    const poller = fakePoller();
    const handle = startCommandIntake({
      readStored: () => Promise.resolve({ mode: "both", pollSeconds: 60 }),
      envPollMs: "60000",
      canReadComments: false,
      startPoller: poller.start,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(poller.starts).toEqual([]);

    const status = handle.status();
    expect(status.mode).toBe("both");
    expect(status.canReadComments).toBe(false);
    // Zero because zero is what the loop is actually doing.
    expect(status.pollSeconds).toBe(0);
    handle.stop();
  });

  /**
   * A database hiccup must not revert an operator's answer to the environment
   * variable — nor tear down a poller that is working.
   */
  it("keeps the running poller when the parameter store is briefly down", async () => {
    const poller = fakePoller();
    let fail = false;
    const handle = startCommandIntake({
      readStored: () =>
        fail ? Promise.reject(new Error("db down")) : Promise.resolve({ mode: "poll", pollSeconds: 60 }),
      envPollMs: undefined,
      canReadComments: true,
      startPoller: poller.start,
      superviseMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(poller.starts).toEqual([60_000]);

    fail = true;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(poller.stops).toBe(0);
    expect(handle.status().pollSeconds).toBe(60);
    handle.stop();
  });

  it("reports appliesLive so the wizard can promise a restart-free change", async () => {
    const poller = fakePoller();
    const handle = startCommandIntake({
      readStored: () => Promise.resolve({}),
      envPollMs: undefined,
      canReadComments: true,
      startPoller: poller.start,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(handle.status().appliesLive).toBe(true);
    handle.stop();
  });

  it("stops the poller when the supervisor is stopped", async () => {
    const poller = fakePoller();
    const handle = startCommandIntake({
      readStored: () => Promise.resolve({ mode: "poll", pollSeconds: 60 }),
      envPollMs: undefined,
      canReadComments: true,
      startPoller: poller.start,
    });
    await vi.advanceTimersByTimeAsync(0);
    handle.stop();
    expect(poller.stops).toBe(1);
  });

  /**
   * The composition root's window onto every decision.
   *
   * `bin/bff.ts` prints the boot banner from the first call and a transition
   * line from every later one that DIFFERS — which is how an operator who
   * changed the setting in the panel verifies from the log that their click
   * took effect, on a server they have no shell on. The supervisor reports;
   * deciding what is worth printing stays with the caller, which is why this
   * fires every round rather than only on a change.
   */
  it("reports the decision in force on every round", async () => {
    const poller = fakePoller();
    const seen: string[] = [];
    let stored: StoredCommandIntake = {};
    const handle = startCommandIntake({
      readStored: () => Promise.resolve(stored),
      envPollMs: undefined,
      canReadComments: true,
      startPoller: poller.start,
      superviseMs: 1_000,
      onDecision: (decision) => seen.push(`${decision.mode}:${decision.pollSeconds}:${decision.source}`),
    });

    await vi.advanceTimersByTimeAsync(0);
    // The boot decision, reported before the first round could poll anything.
    expect(seen[0]).toBe("webhook:0:default");

    stored = { mode: "both", pollSeconds: 45 };
    await vi.advanceTimersByTimeAsync(1_000);
    // The operator's saved answer, reported the round it took effect — and it
    // really did take effect, which is the point of printing it.
    expect(seen).toContain("both:45:param");
    expect(poller.starts).toEqual([45_000]);
    handle.stop();
  });

  /**
   * The lock, seen through the reported decision: a driver that cannot read a
   * comment thread never polls, whatever is stored. The DECISION still reports
   * the stored answer honestly — the banner needs to say "you asked for
   * polling and this driver cannot" rather than pretend nobody asked.
   */
  it("reports the stored answer even when the driver cannot honour it", async () => {
    const poller = fakePoller();
    const seen: string[] = [];
    const handle = startCommandIntake({
      readStored: () => Promise.resolve({ mode: "poll", pollSeconds: 30 }),
      envPollMs: undefined,
      canReadComments: false,
      startPoller: poller.start,
      onDecision: (decision) => seen.push(`${decision.mode}:${decision.pollSeconds}`),
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(seen[0]).toBe("poll:30");
    // Reported, and NOT started.
    expect(poller.starts).toEqual([]);
    expect(handle.status().pollSeconds).toBe(0);
    expect(handle.status().canReadComments).toBe(false);
    handle.stop();
  });
});
