import type { DataClass } from "@maestro/contracts";
import type { OutboundCall, PiiPolicy } from "@maestro/pii";
import type { LlmPort } from "@maestro/ports";
import { type BootstrapContext, type BootstrapLimits, composeTurnPrompt } from "./bootstrap.js";
import { createReportJournal, runVerification, type SessionReport, summarizeDiff, verificationFailures } from "./collect.js";
import { WorkspaceProbeError } from "./errors.js";
import { createProtectedPathMatcher, findProtectedViolations, type ProtectedPathViolation } from "./protected-paths.js";
import { ciFingerprint, handoverDecision, type HandoverDecision, type StrikeKey, type StrikeLedger, type StrikeState } from "./strikes.js";
import type { ChangedFile, CommandResult, CommandSpec, VerificationRunner, WorkspaceProbe } from "./types.js";

export interface AgentTurnRequest {
  readonly context: BootstrapContext;
  readonly dataClass: DataClass;
  readonly variantId: string;
  /** Present → resume (no bootstrap is re-sent), absent → new session (M30). */
  readonly resumeToken?: string;
  readonly verification: readonly CommandSpec[];
}

export type FailureReason = "protected_path" | "verification";

export type AgentTurnResult =
  | { readonly status: "ok"; readonly report: SessionReport }
  | {
      readonly status: "failed";
      readonly reason: FailureReason;
      readonly report: SessionReport;
      readonly handover: HandoverDecision;
    }
  | { readonly status: "queued"; readonly resumeAt: string }
  | { readonly status: "degraded"; readonly messageKey: string }
  | { readonly status: "blocked"; readonly messageKey: string };

export interface AgentExecutionDeps {
  readonly llm: LlmPort;
  readonly probe: WorkspaceProbe;
  readonly verifier: VerificationRunner;
  readonly strikes: StrikeLedger;
  readonly piiPolicy: PiiPolicy;
  /** Masked report sink (journal row + StoragePort body). */
  readonly journalSink: OutboundCall<SessionReport, unknown>;
  readonly now: () => Date;
  readonly bootstrapLimits?: BootstrapLimits;
}

/**
 * One doing-role turn, end to end: bootstrap or resume → agent session →
 * protected-path gate → verification → masked journal write → strike/handover.
 * The order matters: M52 stops the flow on a protected diff, and a green build
 * on top of an illegal change would read like an endorsement of it.
 */
export class AgentExecution {
  constructor(private readonly deps: AgentExecutionDeps) {}

  async runTurn(req: AgentTurnRequest): Promise<AgentTurnResult> {
    const ctx = req.context;
    const isResume = req.resumeToken !== undefined;
    const outcome = await this.deps.llm.agentSession({
      workspacePath: ctx.workspace.path,
      task: composeTurnPrompt(ctx, isResume, this.deps.bootstrapLimits),
      mcpServers: [...ctx.mcpServers],
      dataClass: req.dataClass,
      variantId: req.variantId,
      ...(req.resumeToken === undefined ? {} : { resumeToken: req.resumeToken }),
    });

    switch (outcome.status) {
      case "queued":
        return { status: "queued", resumeAt: outcome.resumeAt };
      case "degraded":
        return { status: "degraded", messageKey: outcome.messageKey };
      case "blocked":
        return { status: "blocked", messageKey: outcome.messageKey };
      case "ok":
        break;
    }

    const changed = await this.inspect(ctx.workspace.path);
    const violations = findProtectedViolations(changed, createProtectedPathMatcher(ctx.protectedPaths));
    // M52 is fail-closed: stop here, do not spend a build on an illegal diff.
    const commands =
      violations.length > 0 ? [] : await runVerification(this.deps.verifier, ctx.workspace.path, req.verification);
    const verdict = this.judge(ctx.runId, violations, commands);

    const report: SessionReport = {
      runId: ctx.runId,
      ticketKey: ctx.ticketKey,
      resumeToken: outcome.value.resumeToken,
      workspacePath: ctx.workspace.path,
      finalText: outcome.value.finalText,
      changedFiles: changed,
      diff: summarizeDiff(changed),
      commands,
      protectedViolations: violations,
      strikes: verdict?.state ?? null,
      at: this.deps.now().toISOString(),
    };
    await this.publish(report, req.dataClass);

    if (verdict === null) return { status: "ok", report };
    return { status: "failed", reason: verdict.reason, report, handover: verdict.handover };
  }

  private async inspect(workspacePath: string): Promise<readonly ChangedFile[]> {
    try {
      return await this.deps.probe.changedFiles(workspacePath);
    } catch (cause) {
      throw new WorkspaceProbeError(workspacePath, cause instanceof Error ? cause.message : String(cause));
    }
  }

  /** Records a strike (or clears the run's) and returns why the turn failed. */
  private judge(
    runId: string,
    violations: readonly ProtectedPathViolation[],
    commands: readonly CommandResult[],
  ): { reason: FailureReason; state: StrikeState; handover: HandoverDecision } | null {
    if (violations.length > 0) {
      const key: StrikeKey = { runId, scope: "agent", ref: "protected_path" };
      const state = this.deps.strikes.record(key, violations.map((v) => `${v.path} (${v.pattern})`).join(", "));
      return { reason: "protected_path", state, handover: handoverDecision(state) };
    }
    const failures = verificationFailures(commands);
    if (failures.length > 0) {
      const digest = failures.map((f) => `${f.name}#${f.exitCode}\n${f.stderrTail}\n${f.stdoutTail}`).join("\n");
      const key: StrikeKey = { runId, scope: "ci", ref: ciFingerprint(digest) };
      const state = this.deps.strikes.record(key, failures.map((f) => `${f.name} exited ${f.exitCode}`).join(", "));
      return { reason: "verification", state, handover: handoverDecision(state) };
    }
    this.deps.strikes.clear({ runId, scope: "agent", ref: "protected_path" });
    return null;
  }

  private async publish(report: SessionReport, dataClass: DataClass): Promise<void> {
    const write = createReportJournal({
      policy: this.deps.piiPolicy,
      dataClass,
      sink: this.deps.journalSink,
    });
    await write(report);
  }
}
