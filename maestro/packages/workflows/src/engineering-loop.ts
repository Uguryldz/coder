import { condition } from "@temporalio/workflow";
import type { StepId, TicketKey } from "@maestro/contracts";
import type { EngineeringResult, MaestroActivities } from "./activities.js";
import { MAX_GATE_REJECTIONS, type Inbox, type RunState } from "./run-state.js";

/**
 * Steps 6a-10: build, scan, review, design tests, review those, run them.
 *
 * The loop is bounded (M54) and every exit is explicit — it either reaches
 * green tests, or it names the reason a human must take over. It never returns
 * "done" on anything less than a clean pass: a blocked scan and a red test run
 * both go back to 6a rather than forward, which is the fail-closed property the
 * whole step exists for (M27).
 */

/** What the loop decided: carry on to the PR, or stop and hand over. */
export type EngineeringOutcome =
  | { readonly kind: "ready"; readonly attempts: number }
  | { readonly kind: "handover"; readonly reason: string };

export interface EngineeringLoopDeps {
  /** The ordinary proxy — short activities with a small retry budget. */
  readonly acts: MaestroActivities;
  /** The patient proxy — an agent turn may legitimately run for hours. */
  readonly longActs: MaestroActivities;
  /** Announce a step transition (and let the kill switch stop the run). */
  readonly goto: (next: StepId, note: string) => Promise<void>;
  /**
   * Open a human gate and wait for a real decision.
   *
   * `return_analysis` is in the union for TYPE completeness only: `canCloseGate`
   * refuses it at every gate but 4 and 5 (`not_returnable`) and `decideGate`
   * never sends it there, so it cannot arrive here. It is spelled out rather
   * than narrowed away so the compiler keeps the callers below honest — the
   * decision below reads `=== "approve"` rather than `!== "reject"` precisely
   * because "anything that is not a rejection is an approval" is how a third
   * verdict would silently become a merge.
   */
  readonly gate: (
    at: StepId,
  ) => Promise<{ decision: "approve" | "reject" | "return_analysis"; reason?: string }>;
}

export async function runEngineeringLoop(
  deps: EngineeringLoopDeps,
  state: RunState,
  inbox: Inbox,
  ticket: TicketKey,
  required: readonly StepId[],
): Promise<EngineeringOutcome> {
  const { acts, longActs, goto, gate } = deps;
  let attempt = 0;

  for (;;) {
    attempt += 1;
    if (attempt > MAX_GATE_REJECTIONS) {
      return { kind: "handover", reason: `${MAX_GATE_REJECTIONS} tur ilerleme yok (M54)` };
    }

    await goto("6a", `geliştirme turu ${attempt}`);
    // Findings from the previous lap become this lap's task, then are cleared:
    // carrying them twice would ask the agent to fix what it just fixed.
    const task = inbox.changesRequested ?? "analizdeki kabul kriterlerini karşıla";
    inbox.changesRequested = undefined;
    const eng: EngineeringResult = await longActs.runEngineering(ticket, state.resumeToken, task, attempt);
    state.resumeToken = eng.resumeToken;
    if (!eng.ok) {
      if (eng.handoverReason !== undefined) return { kind: "handover", reason: eng.handoverReason };
      continue;
    }

    // 6b · scans — fail-closed: anything but a clean pass goes back (M27).
    await goto("6b", "güvenlik taraması");
    const scans = await acts.runScans(ticket, attempt);
    if (scans.some((s) => s.outcome !== "pass")) {
      await acts.journal(ticket, "scan", "tarama bloke etti", "bulgularla 6a'ya dönüldü");
      continue;
    }

    // 6c · dev-reviewer
    await goto("6c", "diff incelemesi");
    const review = await acts.reviewDiff(ticket, attempt);
    if (!review.approved) {
      inbox.changesRequested = review.findings.join("\n");
      continue;
    }

    // 7-8 · test design and its four-eyes review
    await goto("7", "test senaryoları");
    await acts.designTests(ticket, attempt);
    await goto("8", "senaryo denetimi");
    const testReview = await acts.reviewTests(ticket, attempt);
    if (!testReview.approved) {
      inbox.changesRequested = testReview.findings.join("\n");
      continue;
    }

    // 9 · QA scenario gate (only in the tiers that require it)
    if (required.includes("9")) {
      await goto("9", "QA senaryo onayı");
      const qa = await gate("9");
      // Explicitly "not an approval" rather than "a rejection": a verdict this
      // gate does not understand must send the work back, never let it through.
      if (qa.decision !== "approve") {
        inbox.changesRequested = qa.reason ?? "";
        continue;
      }
    }

    // 10 · the tests actually run. The verdict comes from exit codes, never
    // from a summary (see `impl/engineering.ts`).
    await goto("10", "testler koşuyor");
    const run = await acts.runTests(ticket, attempt);
    if (!run.passed) {
      await acts.journal(ticket, "test_run", "testler kırmızı", `${run.failed}/${run.total}`);
      continue;
    }
    return { kind: "ready", attempts: attempt };
  }
}

/**
 * Step 10b: wait for build validation, and fix the branch until it is green.
 *
 * Two rules this loop exists to enforce. A result whose origin is not this
 * run's repository is not evidence and is refused (M106) — the gate keeps
 * waiting rather than treating a neighbouring pipeline's success as its own.
 * And the queue is never cleared: a fix can take hours, ADO reports a finished
 * build exactly once, so a green result that lands mid-fix has to survive until
 * the loop comes back to look at it.
 */
/** How often 10b asks the SCM for the commit's checks when no webhook has spoken. */
export const CI_POLL_INTERVAL = "2 minutes";
/**
 * Polls that may answer "no check reported" before 10b concludes the repo
 * has no CI at all. GitHub creates check runs seconds after a push; a few
 * quiet rounds is the difference between "not yet" and "never".
 */
export const CI_NONE_GRACE_ROUNDS = 3;

/**
 * Wait for the build on the published commit to be green.
 *
 * Two sources, whichever speaks first: the CI webhook (ADO's path, the
 * `ciResults` inbox) or, when the webhook is silent for one interval, the
 * SCM's own checks for `sha` (GitHub's path — nothing ever posted a signal
 * for a GitHub repo, so this loop used to wait forever at 10b). A repo with
 * no CI at all is not a red build: after a grace window of "no check
 * reported" rounds the verification that ran in 6a stands as the evidence,
 * and the journal says so.
 *
 * A red build is fixed by the same session (6a again) and the fix is
 * PUBLISHED before the next wait: a fix left in the clone is invisible to CI.
 */
export async function awaitGreenBuild(
  deps: Pick<EngineeringLoopDeps, "acts" | "longActs">,
  state: RunState,
  inbox: Inbox,
  ticket: TicketKey,
  afterAttempt: number,
  publishedSha: string | null = null,
): Promise<EngineeringOutcome> {
  const { acts, longActs } = deps;
  let fixes = 0;
  let sha = publishedSha;
  let quietRounds = 0;
  for (;;) {
    const signalled = await condition(() => inbox.ciResults.length > 0, CI_POLL_INTERVAL);
    let verdict: "green" | "red" | null = null;
    let why = "";
    if (signalled) {
      const signal = inbox.ciResults.shift();
      if (signal === undefined) continue;
      if (!(await acts.verifyCiOrigin(ticket, signal))) {
        await acts.journal(ticket, "ci", "yabancı CI sinyali reddedildi", signal.adoRepo ?? "?");
        continue;
      }
      verdict = signal.status === "succeeded" ? "green" : "red";
      why = `build ${String(signal.buildId)}: ${signal.status}`;
    } else {
      if (sha === null) continue;
      const poll = await acts.pollBuild(ticket, sha);
      switch (poll.state) {
        case "success":
          verdict = "green";
          why = poll.detail.join(", ");
          break;
        case "failure":
          verdict = "red";
          why = poll.detail.join(", ");
          break;
        case "none":
          quietRounds += 1;
          if (quietRounds < CI_NONE_GRACE_ROUNDS) continue;
          await acts.journal(
            ticket,
            "ci",
            "CI tanımlı değil",
            `${sha.slice(0, 10)} için hiçbir kontrol raporlanmadı — 6a'daki derleme doğrulaması kanıt sayılıyor`,
          );
          return { kind: "ready", attempts: afterAttempt + fixes };
        case "pending":
        case "unsupported":
          continue;
      }
    }
    if (verdict === "green") {
      await acts.journal(ticket, "ci", "CI yeşil", why);
      return { kind: "ready", attempts: afterAttempt + fixes };
    }
    fixes += 1;
    if (fixes > MAX_GATE_REJECTIONS) {
      return { kind: "handover", reason: `${fixes - 1} kez CI düzeltilemedi (M54)` };
    }
    await acts.journal(ticket, "ci", "CI kırmızı", `${why} — 6a'ya dönülüyor`);
    const fix: EngineeringResult = await longActs.runEngineering(
      ticket,
      state.resumeToken,
      `CI hatasını düzelt: ${why}`,
      afterAttempt + fixes,
    );
    state.resumeToken = fix.resumeToken;
    if (!fix.ok && fix.handoverReason !== undefined) {
      return { kind: "handover", reason: fix.handoverReason };
    }
    const published = await acts.publishBranch(ticket);
    if (!published.pushed) return { kind: "handover", reason: `CI düzeltmesi yayımlanamadı: ${published.reason}` };
    sha = published.sha;
    quietRounds = 0;
  }
}
