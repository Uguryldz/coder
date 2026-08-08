import { assertNoPii, compileProfile, defaultPiiPolicy, type Masked } from "@maestro/pii";
import { describe, expect, it } from "vitest";
import {
  createReportJournal,
  JOURNAL_BOUNDARY,
  runVerification,
  type SessionReport,
  summarizeDiff,
  verificationFailures,
} from "../src/collect.js";
import { changed, SAMPLE_IBAN, stubVerifier } from "./helpers.js";

function report(over: Partial<SessionReport> = {}): SessionReport {
  return {
    runId: "run-000001",
    ticketKey: "UGURPAY-42",
    resumeToken: "resume-1",
    workspacePath: "/w/UGURPAY-42",
    finalText: "done",
    changedFiles: [changed("src/a.ts")],
    diff: { files: 1, insertions: 3, deletions: 1 },
    commands: [],
    protectedViolations: [],
    strikes: null,
    at: "2026-08-08T10:00:00.000Z",
    ...over,
  };
}

describe("summarizeDiff", () => {
  it("adds up the working copy", () => {
    expect(
      summarizeDiff([changed("a.ts"), changed("b.ts", { insertions: 10, deletions: 0, status: "added" })]),
    ).toEqual({ files: 2, insertions: 13, deletions: 1 });
  });

  it("is zero for an untouched workspace", () => {
    expect(summarizeDiff([])).toEqual({ files: 0, insertions: 0, deletions: 0 });
  });
});

describe("runVerification", () => {
  it("runs every command in order and keeps the failures", async () => {
    const verifier = stubVerifier({ lint: 0, build: 1, test: 1 }, "boom");
    const results = await runVerification(verifier, "/w", [
      { name: "lint", command: ["pnpm", "lint"] },
      { name: "build", command: ["pnpm", "build"] },
      { name: "test", command: ["pnpm", "test"] },
    ]);
    expect(verifier.seen.map((s) => s.name)).toEqual(["lint", "build", "test"]);
    expect(results).toHaveLength(3);
    expect(verificationFailures(results).map((r) => r.name)).toEqual(["build", "test"]);
  });

  it("reports nothing to fix when everything is green", async () => {
    const results = await runVerification(stubVerifier({}), "/w", [{ name: "test", command: ["pnpm", "test"] }]);
    expect(verificationFailures(results)).toEqual([]);
  });
});

describe("createReportJournal", () => {
  it("stores the MASKED report and never the raw one (M20/M82)", async () => {
    const stored: SessionReport[] = [];
    const write = createReportJournal<void>({
      policy: defaultPiiPolicy(),
      dataClass: "dahili",
      sink: (payload: Masked<SessionReport>) => {
        stored.push(payload);
        return Promise.resolve();
      },
    });

    const raw = report({
      finalText: `refunded ${SAMPLE_IBAN}`,
      commands: [
        {
          name: "test",
          command: ["pnpm", "test"],
          exitCode: 1,
          stdoutTail: `expected ${SAMPLE_IBAN}`,
          stderrTail: "",
          durationMs: 5,
        },
      ],
    });
    const result = await write(raw);

    const written = stored[0] as SessionReport;
    expect(written.finalText).not.toContain(SAMPLE_IBAN);
    expect(written.finalText).toMatch(/\[IBAN_\d+\]/);
    // Command output is masked too: a failing test is a classic leak path.
    expect(written.commands[0]?.stdoutTail).not.toContain(SAMPLE_IBAN);
    expect(result.counts.occurrences).toBeGreaterThan(0);
    expect(result.dataClass).toBe("dahili");
  });

  it("leaves the masked copy clean under an independent scan", async () => {
    const stored: SessionReport[] = [];
    const write = createReportJournal<void>({
      policy: defaultPiiPolicy(),
      dataClass: "gizli",
      sink: (payload: Masked<SessionReport>) => {
        stored.push(payload);
        return Promise.resolve();
      },
    });
    await write(report({ finalText: `iban ${SAMPLE_IBAN}, mail a.yilmaz@banka.com.tr` }));
    expect(() =>
      assertNoPii(stored[0], compileProfile(defaultPiiPolicy().profiles.gizli), "test"),
    ).not.toThrow();
  });

  it("falls to the strictest profile when the data class is unrecognised", async () => {
    const write = createReportJournal<void>({
      policy: defaultPiiPolicy(),
      dataClass: "whatever-the-webhook-said",
      sink: () => Promise.resolve(),
    });
    const result = await write(report({ finalText: `iban ${SAMPLE_IBAN}` }));
    expect(result.dataClass).toBe("gizli");
  });

  it("un-masks only the copy handed back to the caller", async () => {
    const write = createReportJournal<string>({
      policy: defaultPiiPolicy(),
      dataClass: "dahili",
      // The sink echoes what it stored, so `output` shows what a human would see.
      sink: (payload: Masked<SessionReport>) => Promise.resolve(payload.finalText),
    });
    const result = await write(report({ finalText: `iban ${SAMPLE_IBAN}` }));
    expect(result.maskedOutput).not.toContain(SAMPLE_IBAN);
    expect(result.output).toContain(SAMPLE_IBAN);
  });

  it("cannot be reached with a raw report — the sink's parameter is branded", () => {
    // pii now wraps masked payloads in a nominal envelope: read through .value
    const sink = (payload: Masked<SessionReport>) => Promise.resolve(payload.value.runId);
    // @ts-expect-error a raw SessionReport is not Masked<SessionReport>: the only
    // way to obtain the brand is to go through createReportJournal.
    const bypass = () => sink(report());
    expect(typeof bypass).toBe("function");
  });

  it("names the boundary it guards, so a leak error says where it happened", () => {
    expect(JOURNAL_BOUNDARY).toBe("execution/session-report");
  });
});
