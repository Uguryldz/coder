import type { JournalEntry } from "@maestro/contracts";
import { describe, expect, it } from "vitest";
import { MemoryArgumentError } from "../src/errors.js";
import {
  buildLivingSummary,
  enrichLivingSummary,
  SUMMARY_MAX_CHARS,
} from "../src/summary.js";
import { entry, RUN_ID, SAMPLE_EMAIL, testMasker } from "./fakes/support.js";

/** A long-running ticket: 400 events with gates, scans and a CI verdict. */
function bigJournal(): JournalEntry[] {
  const entries: JournalEntry[] = [];
  for (let seq = 0; seq < 400; seq += 1) {
    if (seq === 10) entries.push(entry({ seq, kind: "gate", actor: "human", title: "PO approved" }));
    else if (seq === 50) entries.push(entry({ seq, kind: "scan", title: "gitleaks: 1 finding" }));
    else if (seq === 60) entries.push(entry({ seq, kind: "ci", title: "build 771 failed" }));
    else if (seq === 200) entries.push(entry({ seq, kind: "gate", actor: "human", title: "TL approved" }));
    else if (seq === 390) entries.push(entry({ seq, kind: "gate", actor: "human", title: "QA approved" }));
    else entries.push(entry({ seq, detail: "x".repeat(300) }));
  }
  return entries;
}

describe("buildLivingSummary", () => {
  it("is deterministic: same journal, same characters", () => {
    const entries = bigJournal();
    const first = buildLivingSummary(RUN_ID, entries);
    const second = buildLivingSummary(RUN_ID, [...entries].reverse());
    expect(first.text).toBe(second.text);
    expect(first.upToSeq).toBe(399);
  });

  it("stays inside the contract's 8000-character ceiling", () => {
    const summary = buildLivingSummary(RUN_ID, bigJournal());
    expect(summary.text.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
  });

  it("keeps the recent events, the gate decisions and the open findings", () => {
    const text = buildLivingSummary(RUN_ID, bigJournal()).text;
    // gates outside the recent window
    expect(text).toContain("PO approved");
    expect(text).toContain("TL approved");
    // latest finding per kind
    expect(text).toContain("gitleaks: 1 finding");
    expect(text).toContain("build 771 failed");
    // the newest events verbatim
    expect(text).toContain("#399");
    expect(text).toContain("QA approved");
    // and the compressed remainder
    expect(text).toContain("## earlier");
  });

  it("shows a superseded finding as replaced by the newer one", () => {
    const entries = [
      entry({ seq: 0, kind: "scan", title: "gitleaks: 3 findings" }),
      entry({ seq: 1, kind: "scan", title: "gitleaks: 0 findings" }),
      ...Array.from({ length: 40 }, (_, i) => entry({ seq: i + 2, detail: "y".repeat(300) })),
    ];
    const text = buildLivingSummary(RUN_ID, entries).text;
    expect(text).toContain("gitleaks: 0 findings");
    expect(text).not.toContain("gitleaks: 3 findings");
  });

  it("shows a short journal in full", () => {
    const entries = [
      entry({ seq: 0, kind: "intake", title: "ticket read" }),
      entry({ seq: 1, kind: "analysis", title: "impact matrix written" }),
    ];
    const text = buildLivingSummary(RUN_ID, entries).text;
    expect(text).toContain("## log");
    expect(text).toContain("#0");
    expect(text).toContain("#1");
  });

  it("survives a journal of pathological entries by clipping, not throwing", () => {
    const entries = Array.from({ length: 300 }, (_, seq) =>
      entry({ seq, title: "t".repeat(4000), detail: "d".repeat(4000) }),
    );
    const summary = buildLivingSummary(RUN_ID, entries);
    expect(summary.text.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
    expect(summary.upToSeq).toBe(299);
  });

  it("handles an empty journal", () => {
    const summary = buildLivingSummary(RUN_ID, []);
    expect(summary.upToSeq).toBe(0);
    expect(summary.text).toContain("journal empty");
  });

  it("refuses a journal that is not one run's, or that repeats a seq", () => {
    expect(() =>
      buildLivingSummary(RUN_ID, [entry({ seq: 0 }), entry({ seq: 0 })]),
    ).toThrow(MemoryArgumentError);
    expect(() =>
      buildLivingSummary(RUN_ID, [entry({ seq: 0, runId: "run-OTHER-0001" })]),
    ).toThrow(MemoryArgumentError);
  });

  it("validates its own options", () => {
    expect(() => buildLivingSummary(RUN_ID, [], { recentCount: 0 })).toThrow(MemoryArgumentError);
    expect(() => buildLivingSummary(RUN_ID, [], { lineChars: 10 })).toThrow(MemoryArgumentError);
    expect(() => buildLivingSummary(RUN_ID, [], { maxChars: 100 })).toThrow(MemoryArgumentError);
  });

  it("never exceeds a caller's smaller budget either", () => {
    const summary = buildLivingSummary(RUN_ID, bigJournal(), { maxChars: 900 });
    expect(summary.text.length).toBeLessThanOrEqual(900);
  });
});

describe("enrichLivingSummary", () => {
  const entries = [entry({ seq: 0, kind: "intake", title: "ticket read" })];

  it("returns the deterministic summary when no enricher is configured", async () => {
    const enriched = await enrichLivingSummary(RUN_ID, entries);
    expect(enriched.text).toBe(buildLivingSummary(RUN_ID, entries).text);
  });

  it("appends the model note and masks it (M82)", async () => {
    const enriched = await enrichLivingSummary(RUN_ID, entries, {
      masker: testMasker(),
      enrich: async () => `the reporter is ${SAMPLE_EMAIL}`,
    });
    expect(enriched.text).toContain("## notes (model)");
    expect(enriched.text).toContain("[EMAIL_1]");
    expect(enriched.text).not.toContain(SAMPLE_EMAIL);
    // Everything the deterministic pass guaranteed is still there, first.
    expect(enriched.text.startsWith(buildLivingSummary(RUN_ID, entries).text)).toBe(true);
  });

  it("falls back to the deterministic summary when the model fails", async () => {
    const failures: unknown[] = [];
    const enriched = await enrichLivingSummary(RUN_ID, entries, {
      masker: testMasker(),
      enrich: async () => {
        throw new Error("gateway queued");
      },
      onEnrichFailed: (error) => failures.push(error),
    });
    expect(enriched.text).toBe(buildLivingSummary(RUN_ID, entries).text);
    expect(failures).toHaveLength(1);
  });

  it("clips a rambling model answer to the remaining budget", async () => {
    const enriched = await enrichLivingSummary(RUN_ID, entries, {
      masker: testMasker(),
      enrich: async () => "n".repeat(20000),
    });
    expect(enriched.text.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
  });

  it("refuses to run a model pass without a masker", async () => {
    await expect(
      enrichLivingSummary(RUN_ID, entries, { enrich: async () => "note" }),
    ).rejects.toBeInstanceOf(MemoryArgumentError);
  });
});
