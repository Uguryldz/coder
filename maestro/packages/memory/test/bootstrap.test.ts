import { GateDecision, type JournalEntry } from "@maestro/contracts";
import { describe, expect, it } from "vitest";
import {
  buildBootstrapPackage,
  openRejections,
  type BootstrapDeps,
  type BootstrapInput,
} from "../src/bootstrap.js";
import { entry, fixedClock, RUN_ID, SAMPLE_EMAIL, testMasker, TICKET_KEY } from "./fakes/support.js";

const NOW = "2026-08-08T12:00:00+03:00";

function deps(): BootstrapDeps {
  return { masker: testMasker(), clock: fixedClock(NOW) };
}

function gate(input: {
  step: GateDecision["step"];
  decision: GateDecision["decision"];
  signatureSeq: number;
  reason?: string;
  at?: string;
}): GateDecision {
  return GateDecision.parse({
    step: input.step,
    decision: input.decision,
    actorUserId: "u.yildiz",
    actorGroup: "tech-lead",
    sodVerified: true,
    signatureSeq: input.signatureSeq,
    source: "studio",
    at: input.at ?? "2026-08-07T09:00:00+03:00",
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  });
}

const JOURNAL: JournalEntry[] = [
  entry({ seq: 0, kind: "intake", title: "ticket read" }),
  entry({ seq: 1, kind: "analysis", title: "impact matrix written" }),
  entry({ seq: 2, kind: "gate", actor: "human", title: "TL rejected: migration touched" }),
  entry({ seq: 3, kind: "engineering", title: "patch reworked" }),
];

function input(overrides: Partial<BootstrapInput> = {}): BootstrapInput {
  return {
    runId: RUN_ID,
    ticketKey: TICKET_KEY,
    entries: JOURNAL,
    gateDecisions: [gate({ step: "5", decision: "reject", signatureSeq: 4, reason: "migration touched" })],
    lastDiff: {
      sha: "abc1234",
      filesChanged: ["src/pay/service.ts", "db/migrations/0007_add_col.sql"],
      insertions: 40,
      deletions: 3,
      note: "reworked the mapper",
    },
    protectedPaths: ["db/migrations/**", "**/*.pem"],
    workspacePresent: true,
    ...overrides,
  };
}

describe("openRejections", () => {
  const identity = (text: string): string => text;

  it("keeps a rejection open until the same step is approved", () => {
    const open = openRejections(
      [
        gate({ step: "5", decision: "reject", signatureSeq: 1, reason: "no tests" }),
        gate({ step: "5", decision: "approve", signatureSeq: 2 }),
        gate({ step: "12", decision: "reject", signatureSeq: 3, reason: "PR too wide" }),
      ],
      identity,
    );
    expect(open.map((item) => item.step)).toEqual(["12"]);
    expect(open[0]?.reason).toBe("PR too wide");
  });

  it("orders by the signed chain, not by array order", () => {
    const open = openRejections(
      [
        gate({ step: "5", decision: "approve", signatureSeq: 9 }),
        gate({ step: "5", decision: "reject", signatureSeq: 2, reason: "early" }),
      ],
      identity,
    );
    expect(open).toEqual([]);
  });

  it("masks the reason on its way out (M82)", () => {
    const masker = testMasker();
    const open = openRejections(
      [gate({ step: "9", decision: "reject", signatureSeq: 1, reason: `ask ${SAMPLE_EMAIL}` })],
      (text) => masker.text(text),
    );
    expect(open[0]?.reason).toMatch(/\[EMAIL_1\.[0-9a-f]+\]/);
    expect(open[0]?.reason).not.toContain(SAMPLE_EMAIL);
  });
});

describe("buildBootstrapPackage", () => {
  it("carries summary, diff, open rejections and protected paths", () => {
    const pack = buildBootstrapPackage(input(), deps());
    expect(pack.generatedAt).toBe(NOW);
    expect(pack.upToSeq).toBe(3);
    expect(pack.text).toContain("## living summary");
    expect(pack.text).toContain("impact matrix written");
    expect(pack.text).toContain("## last diff");
    expect(pack.text).toContain("sha abc1234");
    expect(pack.text).toContain("## open rejections");
    expect(pack.text).toContain("migration touched");
    expect(pack.text).toContain("## protected paths");
    expect(pack.diff?.fileCount).toBe(2);
  });

  it("warns that the last diff already touches a protected path (M52)", () => {
    const pack = buildBootstrapPackage(input(), deps());
    expect(pack.protectedPathHits).toEqual([
      { file: "db/migrations/0007_add_col.sql", pattern: "db/migrations/**" },
    ]);
    expect(pack.text).toContain("!! the last diff already touches protected paths");
  });

  it("falls back to the M52 defaults when the repo declares none", () => {
    const pack = buildBootstrapPackage(input({ protectedPaths: undefined }), deps());
    expect(pack.protectedPaths).toContain("**/migrations/**");
    expect(pack.protectedPathHits.map((hit) => hit.file)).toEqual([
      "db/migrations/0007_add_col.sql",
    ]);
  });

  it("loses no context when the workspace was deleted (M65)", () => {
    const withWorkspace = buildBootstrapPackage(input(), deps());
    const archived = buildBootstrapPackage(
      input({ workspacePresent: false, sessionRestored: true }),
      deps(),
    );

    // Everything the agent needs is identical; only the two status lines differ.
    expect(archived.summary.text).toBe(withWorkspace.summary.text);
    expect(archived.openRejections).toEqual(withWorkspace.openRejections);
    expect(archived.diff).toEqual(withWorkspace.diff);
    expect(archived.protectedPathHits).toEqual(withWorkspace.protectedPathHits);

    const strip = (text: string): string =>
      text
        .split("\n")
        .filter((line) => !line.startsWith("workspace:") && !line.startsWith("session:"))
        .join("\n");
    expect(strip(archived.text)).toBe(strip(withWorkspace.text));

    expect(archived.text).toContain("workspace: ABSENT");
    expect(archived.text).toContain("60 days");
    expect(archived.text).toContain("nothing has been lost");
    expect(archived.text).toContain("session: restored from the archive");
  });

  it("tells a session-less resume to start fresh from the written context", () => {
    const pack = buildBootstrapPackage(
      input({ workspacePresent: false, sessionRestored: false }),
      deps(),
    );
    expect(pack.text).toContain("no agent session file available");
    expect(pack.text).toContain("impact matrix written");
  });

  it("masks anything a caller assembled by hand", () => {
    const pack = buildBootstrapPackage(
      input({
        lastDiff: {
          filesChanged: ["src/a.ts"],
          note: `pinged ${SAMPLE_EMAIL} about the mapper`,
        },
      }),
      deps(),
    );
    expect(pack.diff?.note).toMatch(/\[EMAIL_1\.[0-9a-f]+\]/);
    expect(pack.text).not.toContain(SAMPLE_EMAIL);
  });

  it("keeps a huge diff listing inside the text budget", () => {
    const pack = buildBootstrapPackage(
      input({
        lastDiff: {
          filesChanged: Array.from({ length: 500 }, (_, i) => `src/file-${i}.ts`),
        },
      }),
      { ...deps(), maxChars: 4000 },
    );
    expect(pack.text.length).toBeLessThanOrEqual(4000);
    expect(pack.text).toContain("more files)");
  });

  it("works with nothing but a journal", () => {
    const pack = buildBootstrapPackage(
      { runId: RUN_ID, ticketKey: TICKET_KEY, entries: JOURNAL, workspacePresent: false },
      deps(),
    );
    expect(pack.openRejections).toEqual([]);
    expect(pack.diff).toBeUndefined();
    expect(pack.text).toContain("## living summary");
  });
});
