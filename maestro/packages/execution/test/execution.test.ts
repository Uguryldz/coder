import { defaultPiiPolicy, type Masked } from "@maestro/pii";
import { describe, expect, it } from "vitest";
import type { SessionReport } from "../src/collect.js";
import { WorkspaceProbeError } from "../src/errors.js";
import { AgentExecution, type AgentExecutionDeps, type AgentTurnRequest } from "../src/execution.js";
import { StrikeLedger } from "../src/strikes.js";
import {
  bootstrapContext,
  changed,
  failingProbe,
  fixedProbe,
  okSession,
  SAMPLE_IBAN,
  stubLlm,
  stubVerifier,
  tickingClock,
  type LlmStub,
} from "./helpers.js";

const VERIFY = [
  { name: "lint", command: ["pnpm", "lint"] },
  { name: "test", command: ["pnpm", "test"] },
];

interface Harness {
  execution: AgentExecution;
  llm: LlmStub;
  stored: SessionReport[];
  strikes: StrikeLedger;
}

function harness(over: Partial<AgentExecutionDeps> = {}, llm: LlmStub = stubLlm([okSession()])): Harness {
  const stored: SessionReport[] = [];
  const strikes = (over.strikes as StrikeLedger | undefined) ?? new StrikeLedger(tickingClock());
  const deps: AgentExecutionDeps = {
    llm,
    probe: fixedProbe([changed("src/pay/mapper.ts")]),
    verifier: stubVerifier({}),
    piiPolicy: defaultPiiPolicy(),
    journalSink: (payload: Masked<SessionReport>) => {
      stored.push(payload);
      return Promise.resolve(undefined);
    },
    now: tickingClock(),
    ...over,
    strikes,
  };
  return { execution: new AgentExecution(deps), llm, stored, strikes };
}

function request(over: Partial<AgentTurnRequest> = {}): AgentTurnRequest {
  return {
    context: bootstrapContext(),
    dataClass: "dahili",
    variantId: "v1",
    verification: VERIFY,
    ...over,
  };
}

describe("AgentExecution.runTurn — happy path", () => {
  it("collects changes, diff, commands and the resume token", async () => {
    const h = harness();
    const result = await h.execution.runTurn(request());
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.report.resumeToken).toBe("resume-1");
    expect(result.report.diff).toEqual({ files: 1, insertions: 3, deletions: 1 });
    expect(result.report.commands.map((c) => c.name)).toEqual(["lint", "test"]);
    expect(result.report.protectedViolations).toEqual([]);
    expect(result.report.at).toBe("2026-08-08T10:00:00.000Z");
  });

  it("bootstraps a new session and passes the caller's data class and variant", async () => {
    const h = harness();
    await h.execution.runTurn(request());
    const opts = h.llm.calls[0];
    expect(opts?.task).toContain("# Session bootstrap");
    expect(opts?.dataClass).toBe("dahili");
    expect(opts?.variantId).toBe("v1");
    expect(opts?.resumeToken).toBeUndefined();
    expect(opts?.mcpServers).toEqual(["jira", "workspace"]);
  });

  it("sends the task alone when resuming (M30)", async () => {
    const h = harness();
    await h.execution.runTurn(request({ resumeToken: "resume-1" }));
    const opts = h.llm.calls[0];
    expect(opts?.task).toBe(bootstrapContext().task);
    expect(opts?.resumeToken).toBe("resume-1");
  });

  it("writes a masked report to the journal (M20/M82)", async () => {
    const llm = stubLlm([okSession({ finalText: `refunded ${SAMPLE_IBAN}` })]);
    const h = harness({}, llm);
    const result = await h.execution.runTurn(request());
    expect(result.status).toBe("ok");
    expect(h.stored).toHaveLength(1);
    expect(h.stored[0]?.finalText).not.toContain(SAMPLE_IBAN);
    if (result.status === "ok") expect(result.report.finalText).toContain(SAMPLE_IBAN);
  });
});

describe("AgentExecution.runTurn — protected paths (M52)", () => {
  it("fails the turn fail-closed and names the file", async () => {
    const h = harness({ probe: fixedProbe([changed("db/migrations/002.sql", { status: "added" })]) });
    const result = await h.execution.runTurn(
      request({ context: { ...bootstrapContext(), protectedPaths: ["**/migrations/**"] } }),
    );
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.reason).toBe("protected_path");
    expect(result.report.protectedViolations).toEqual([
      { path: "db/migrations/002.sql", pattern: "**/migrations/**", status: "added" },
    ]);
  });

  it("does not spend a build on an illegal diff", async () => {
    const verifier = stubVerifier({});
    const h = harness({ probe: fixedProbe([changed("db/migrations/002.sql")]), verifier });
    await h.execution.runTurn(request());
    expect(verifier.seen).toEqual([]);
  });

  it("still journals the failed turn, masked", async () => {
    const h = harness({ probe: fixedProbe([changed("db/migrations/002.sql")]) });
    await h.execution.runTurn(request());
    expect(h.stored).toHaveLength(1);
    expect(h.stored[0]?.protectedViolations).toHaveLength(1);
  });

  it("fails when the workspace cannot be inspected — 'nothing changed' is unprovable", async () => {
    const h = harness({ probe: failingProbe("git exited 128") });
    await expect(h.execution.runTurn(request())).rejects.toBeInstanceOf(WorkspaceProbeError);
  });
});

describe("AgentExecution.runTurn — verification and the 3-strike rule (M54)", () => {
  it("fails the turn when a command is red and counts a strike", async () => {
    const strikes = new StrikeLedger(tickingClock());
    const h = harness({ verifier: stubVerifier({ test: 1 }, "FAIL mapper"), strikes });
    const result = await h.execution.runTurn(request());
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.reason).toBe("verification");
    expect(result.handover.handover).toBe(false);
    expect(result.report.strikes?.count).toBe(1);
  });

  it("hands over to a human on the third identical CI failure", async () => {
    const strikes = new StrikeLedger(tickingClock());
    const llm = stubLlm([okSession(), okSession(), okSession()]);
    const h = harness({ verifier: stubVerifier({ test: 1 }, "FAIL mapper at /w/run-1/src/a.ts:88 (900ms)"), strikes }, llm);
    let last = await h.execution.runTurn(request());
    last = await h.execution.runTurn(request());
    expect(last.status === "failed" && last.handover.handover).toBe(false);
    last = await h.execution.runTurn(request());
    expect(last.status).toBe("failed");
    if (last.status !== "failed") return;
    expect(last.handover).toMatchObject({ handover: true, workMode: "ai_assist", count: 3, limit: 3 });
    expect(last.handover.key.scope).toBe("ci");
  });

  it("keeps two different CI failures on separate counters", async () => {
    const strikes = new StrikeLedger(tickingClock());
    const llm = stubLlm([okSession(), okSession()]);
    const first = harness({ verifier: stubVerifier({ test: 1 }, "FAIL mapper"), strikes }, llm);
    await first.execution.runTurn(request());
    const second = harness({ verifier: stubVerifier({ test: 1 }, "FAIL router"), strikes }, llm);
    const result = await second.execution.runTurn(request());
    expect(result.status === "failed" && result.report.strikes?.count).toBe(1);
  });

  it("clears the protected-path counter when a turn comes back clean", async () => {
    const strikes = new StrikeLedger(tickingClock());
    const llm = stubLlm([okSession(), okSession()]);
    const bad = harness({ probe: fixedProbe([changed("db/migrations/1.sql")]), strikes }, llm);
    await bad.execution.runTurn(request());
    expect(strikes.state({ runId: "run-000001", scope: "agent", ref: "protected_path" })?.count).toBe(1);
    const good = harness({ strikes }, llm);
    await good.execution.runTurn(request());
    expect(strikes.state({ runId: "run-000001", scope: "agent", ref: "protected_path" })).toBeNull();
  });
});

describe("AgentExecution.runTurn — gateway outcomes are passed through, not reinterpreted", () => {
  it("passes a quota queue straight back to the workflow (M55)", async () => {
    const llm = stubLlm([{ status: "queued", resumeAt: "2026-08-08T15:00:00.000Z", reason: "subscription_quota" }]);
    const h = harness({}, llm);
    const result = await h.execution.runTurn(request());
    expect(result).toEqual({ status: "queued", resumeAt: "2026-08-08T15:00:00.000Z" });
    expect(h.stored).toEqual([]);
  });

  it("passes degrade and block through without touching the workspace (M18/M97)", async () => {
    for (const status of ["degraded", "blocked"] as const) {
      const llm = stubLlm([{ status, messageKey: `llm.${status}`, dataClass: "gizli" }]);
      const h = harness({ probe: failingProbe("must not be called") }, llm);
      const result = await h.execution.runTurn(request());
      expect(result).toEqual({ status, messageKey: `llm.${status}` });
    }
  });
});
