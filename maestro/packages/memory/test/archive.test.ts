import { describe, expect, it } from "vitest";
import {
  decideWorkspaceArchive,
  idleDaysBetween,
  latestActivityAt,
  WORKSPACE_MAX_IDLE_DAYS,
} from "../src/archive.js";
import { MemoryArgumentError } from "../src/errors.js";
import { entry, RUN_ID, TICKET_KEY } from "./fakes/support.js";

const NOW = "2026-08-08T12:00:00+03:00";

function daysBefore(days: number): string {
  return new Date(Date.parse(NOW) - days * 86_400_000).toISOString();
}

describe("idleDaysBetween", () => {
  it("counts whole days", () => {
    expect(idleDaysBetween(daysBefore(59.9), NOW)).toBe(59);
    expect(idleDaysBetween(daysBefore(60), NOW)).toBe(60);
  });

  it("reads clock skew as zero, never as negative", () => {
    expect(idleDaysBetween(daysBefore(-5), NOW)).toBe(0);
  });

  it("refuses a value that is not a date", () => {
    expect(() => idleDaysBetween("yesterday", NOW)).toThrow(MemoryArgumentError);
  });
});

describe("latestActivityAt", () => {
  it("is the tail of the journal, whatever order it arrives in", () => {
    const entries = [entry({ seq: 2 }), entry({ seq: 0 }), entry({ seq: 1 })];
    expect(latestActivityAt(entries)).toBe(entry({ seq: 2 }).at);
  });

  it("is null for an empty journal", () => {
    expect(latestActivityAt([])).toBeNull();
  });
});

describe("decideWorkspaceArchive (M65)", () => {
  const base = {
    ticketKey: TICKET_KEY,
    runId: RUN_ID,
    now: NOW,
    workspacePresent: true,
  };

  it("leaves a workspace alone below the idle limit", () => {
    const decision = decideWorkspaceArchive({ ...base, lastActivityAt: daysBefore(59) });
    expect(decision).toEqual({
      archive: false,
      reason: "within_idle_limit",
      idleDays: 59,
      maxIdleDays: WORKSPACE_MAX_IDLE_DAYS,
    });
  });

  it("archives at exactly 60 idle days and names the session key", () => {
    const decision = decideWorkspaceArchive({ ...base, lastActivityAt: daysBefore(60) });
    expect(decision.archive).toBe(true);
    expect(decision.reason).toBe("idle_limit_reached");
    if (decision.archive) {
      expect(decision.sessionKey).toBe(`archive/2026/${TICKET_KEY}/session-${RUN_ID}.session.enc`);
    }
  });

  it("does nothing when the workspace is already gone", () => {
    const decision = decideWorkspaceArchive({
      ...base,
      workspacePresent: false,
      lastActivityAt: daysBefore(400),
    });
    expect(decision).toMatchObject({ archive: false, reason: "workspace_absent", idleDays: 400 });
  });

  it("honours an operator override (M71)", () => {
    expect(
      decideWorkspaceArchive({ ...base, lastActivityAt: daysBefore(10), maxIdleDays: 7 }).archive,
    ).toBe(true);
    expect(
      decideWorkspaceArchive({ ...base, lastActivityAt: daysBefore(10), maxIdleDays: 90 }).archive,
    ).toBe(false);
  });

  it("refuses a nonsensical override rather than guessing", () => {
    expect(() =>
      decideWorkspaceArchive({ ...base, lastActivityAt: daysBefore(10), maxIdleDays: 0 }),
    ).toThrow(MemoryArgumentError);
  });

  it("is a pure function: no clock, no disk, no bucket", () => {
    const input = { ...base, lastActivityAt: daysBefore(120) };
    expect(decideWorkspaceArchive(input)).toEqual(decideWorkspaceArchive(input));
  });
});
