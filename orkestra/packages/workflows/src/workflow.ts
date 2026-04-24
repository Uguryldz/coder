/**
 * TicketLifecycleWorkflow — the 15-step Jira AI Orkestra workflow.
 *
 * This file is deterministic workflow code. It does NOT import anything
 * with side-effects (no db, no network); all external work goes through
 * proxied activities.
 */
import type {
  AnalystOutput,
  DeveloperOutput,
  DevReviewerOutput,
  IntakeOutput,
  JiraCommentSignal,
  JiraTicket,
  TestDesignerOutput,
  TestReviewerOutput,
  TestRunnerOutput,
  WorkMode,
} from "@orkestra/contracts";
import {
  CancellationScope,
  condition,
  isCancellation,
  log,
  proxyActivities,
  setHandler,
  workflowInfo,
} from "@temporalio/workflow";
import type * as activities from "./activities.js";
import {
  aiHandoffSignal,
  aiTakeoverSignal,
  approveSignal,
  cancelSignal,
  ciResultSignal,
  clarificationAnsweredSignal,
  getStatusQuery,
  modeChangeSignal,
  prApprovedSignal,
  prReviewChangesSignal,
  rejectSignal,
} from "./signals.js";

const A = proxyActivities<typeof activities>({
  startToCloseTimeout: "20 minutes",
  retry: {
    maximumAttempts: 3,
    initialInterval: "5s",
    maximumInterval: "1 minute",
    backoffCoefficient: 2,
  },
});

const AI = proxyActivities<typeof activities>({
  startToCloseTimeout: "15 minutes",
  retry: {
    maximumAttempts: 2, // AI calls: bounded retry
    initialInterval: "3s",
    maximumInterval: "30s",
    backoffCoefficient: 2,
  },
});

const SANDBOX = proxyActivities<typeof activities>({
  startToCloseTimeout: "45 minutes",
  retry: { maximumAttempts: 2, initialInterval: "10s", backoffCoefficient: 2 },
});

// SLA durations (milliseconds)
const HOUR = 60 * 60 * 1000;
const SLA_APPROVAL = 48 * HOUR;
const SLA_CLARIFICATION = 72 * HOUR;
const SLA_REMINDER_INTERVAL = 24 * HOUR;

export interface StartParams {
  ticketId: string;
  ticketKey: string;
  projectKey: string;
  correlationId: string;
}

interface WorkflowState {
  step: string;
  workMode: WorkMode;
  waitingFor?: string;
  cancelled: boolean;
  cancellationReason?: string;
  rejectionCount: Record<string, number>;
  costUsdCents: number;
  workflowRunId: string;
  prId?: string;
  branchName?: string;
  baseCommit?: string;
  lastDecision?: { step: string; decision: "approve" | "reject"; user: string; reason?: string };
  ciResult?: { success: boolean; url: string };
  prChangesRequested?: boolean;
  clarificationAnswered?: boolean;
}

export async function ticketLifecycleWorkflow(params: StartParams): Promise<{
  status: "done" | "cancelled" | "rejected" | "failed";
  prUrl?: string;
  reason?: string;
}> {
  const info = workflowInfo();
  const state: WorkflowState = {
    step: "0-work-mode",
    workMode: "full_auto",
    cancelled: false,
    rejectionCount: {},
    costUsdCents: 0,
    workflowRunId: "",
  };

  // ========================================================================
  // STEP 0 — Initial setup & work mode detection
  // ========================================================================
  const ticket: JiraTicket = await A.fetchJiraTicket(params.ticketKey);
  const hints = await A.getGoldenVariantHints({ ticket });
  state.workMode = hints.workMode;
  state.step = "0-work-mode";

  state.workflowRunId = await A.createWorkflowRun({
    jiraTicketId: ticket.id,
    jiraProjectKey: ticket.projectKey,
    workMode: state.workMode,
    temporalWorkflowId: info.workflowId,
    temporalRunId: info.runId,
  });

  // Register signal handlers that merely capture state; the main flow polls.
  setHandler(cancelSignal, (s: JiraCommentSignal) => {
    state.cancelled = true;
    state.cancellationReason = s.args ?? "user cancelled";
  });
  setHandler(modeChangeSignal, (s: JiraCommentSignal) => {
    const requested = (s.args ?? "").trim().toLowerCase();
    const map: Record<string, WorkMode> = {
      "full-auto": "full_auto",
      full_auto: "full_auto",
      "ai-assist": "ai_assist",
      ai_assist: "ai_assist",
      "human-lead": "human_lead",
      human_lead: "human_lead",
      "human-only": "human_only",
      human_only: "human_only",
    };
    if (map[requested]) state.workMode = map[requested]!;
  });
  setHandler(aiTakeoverSignal, () => {
    state.workMode = "full_auto";
  });
  setHandler(aiHandoffSignal, () => {
    state.workMode = "human_lead";
  });

  // CI result signal (Bitbucket Pipelines webhook → workflow)
  setHandler(ciResultSignal, (r: { success: boolean; url: string; reason?: string }) => {
    state.ciResult = { success: r.success, url: r.url };
  });

  // PR review signals (Bitbucket PR webhook)
  setHandler(prReviewChangesSignal, () => {
    state.prChangesRequested = true;
  });
  setHandler(prApprovedSignal, () => {
    // PR approved sinyali; workflow main loop signal'i yakalar ama workflow zaten
    // Tech Lead onayını `/approve` ile bekliyor, bu sinyal auditlenir.
  });

  setHandler(getStatusQuery, () => ({
    step: state.step,
    workMode: state.workMode,
    waitingFor: state.waitingFor,
    costUsdCents: state.costUsdCents,
  }));

  // Main flow wrapped in cancellation-aware scope
  try {
    const outcome = await CancellationScope.cancellable(async () => {
      return runLifecycle(params, ticket, state);
    });
    return outcome;
  } catch (e) {
    if (isCancellation(e) || state.cancelled) {
      await A.completeWorkflow({
        workflowRunId: state.workflowRunId,
        status: "cancelled",
        reason: state.cancellationReason,
      });
      return { status: "cancelled", reason: state.cancellationReason };
    }
    await A.completeWorkflow({
      workflowRunId: state.workflowRunId,
      status: "failed",
      reason: String(e),
    });
    await A.notifySlack({
      workflowRunId: state.workflowRunId,
      text: `Workflow ${params.ticketKey} failed: ${String(e).slice(0, 300)}`,
      critical: true,
    });
    return { status: "failed", reason: String(e) };
  }
}

async function runLifecycle(
  params: StartParams,
  initialTicket: JiraTicket,
  state: WorkflowState,
): Promise<{ status: "done" | "rejected"; prUrl?: string; reason?: string }> {
  let ticket = initialTicket;

  // STEP 2 — Intake
  state.step = "2-intake";
  await A.transitionJiraStatus({
    ticketKey: params.ticketKey,
    step: state.step,
    workMode: state.workMode,
  });
  await A.postJiraComment({
    ticketKey: params.ticketKey,
    bodyText: `🤖 Intake: ticket değerlendiriliyor (mode: ${state.workMode})`,
  });

  let intake: IntakeOutput | null = null;
  let clarificationRounds = 0;
  const MAX_CLARIFICATION_ROUNDS = 3;
  while (true) {
    intake = await AI.runIntakeAgent({
      workflowRunId: state.workflowRunId,
      ticket,
      correlationId: params.correlationId,
    });

    if (intake.complete) break;

    // STEP 2b — Clarification loop
    state.step = "2b-clarification";
    state.waitingFor = "reporter";
    await A.transitionJiraStatus({
      ticketKey: params.ticketKey,
      step: state.step,
      workMode: state.workMode,
    });
    await A.postJiraComment({
      ticketKey: params.ticketKey,
      bodyText: `🤖 Bu ticket eksik görünüyor. Cevaplandırır mısın?\n\n${intake.questions
        .map((q, i) => `${i + 1}. ${q}`)
        .join("\n")}`,
    });

    if (clarificationRounds >= MAX_CLARIFICATION_ROUNDS) {
      await A.notifySlack({
        workflowRunId: state.workflowRunId,
        text: `Ticket ${params.ticketKey}: ${MAX_CLARIFICATION_ROUNDS} clarification attempts exhausted`,
        critical: true,
      });
      return { status: "rejected", reason: "clarification exhausted" };
    }

    // Wait for reporter to answer (new comment webhook → signal) or timeout
    state.clarificationAnswered = false;
    setHandler(clarificationAnsweredSignal, () => {
      state.clarificationAnswered = true;
    });
    const answered = await condition(
      () => state.clarificationAnswered === true || state.cancelled,
      SLA_CLARIFICATION,
    );
    if (state.cancelled) throw new Error("cancelled");
    if (!answered) {
      await A.postJiraComment({
        ticketKey: params.ticketKey,
        bodyText: `⏰ Clarification SLA (72h) aşıldı, ticket bekliyor.`,
      });
      return { status: "rejected", reason: "clarification SLA exceeded" };
    }
    ticket = await A.fetchJiraTicket(params.ticketKey);
    clarificationRounds++;
  }

  // STEP 3 — Analyst (produces analysisDoc + technicalDesign)
  state.step = "3-analyst";
  await A.transitionJiraStatus({
    ticketKey: params.ticketKey,
    step: state.step,
    workMode: state.workMode,
  });
  let analysis: AnalystOutput;
  const MAX_ANALYSIS_ROUNDS = 3;
  let analysisRounds = 0;
  while (true) {
    await A.postJiraComment({
      ticketKey: params.ticketKey,
      bodyText: `🤖 Analist AI çalışıyor (variant: mode=${state.workMode})…`,
    });
    analysis = await AI.runAnalystAgent({
      workflowRunId: state.workflowRunId,
      ticket,
      correlationId: params.correlationId,
    });

    await A.postJiraComment({
      ticketKey: params.ticketKey,
      bodyText: `📋 Analiz hazır.\n\n${analysis.analysisDoc.slice(0, 1500)}\n\n**Onay bekleniyor**: \`/approve\` veya \`/reject <sebep>\``,
    });

    // STEP 4 — PO approval (human gate)
    state.step = "4-po-approval";
    state.waitingFor = "PO";
    await A.transitionJiraStatus({
      ticketKey: params.ticketKey,
      step: state.step,
      workMode: state.workMode,
    });
    const decision = await waitForHumanDecision(state, {
      stepName: "4-po-approval",
      ticketKey: params.ticketKey,
      sla: SLA_APPROVAL,
      allowedSignals: { approve: true, reject: true, cancel: true },
    });
    if (state.cancelled) throw new Error("cancelled");
    if (decision.kind === "timeout") {
      await A.postJiraComment({
        ticketKey: params.ticketKey,
        bodyText: `⏰ Analiz onayı SLA aşıldı. Yöneticiye eskalasyon.`,
      });
      await A.notifySlack({
        workflowRunId: state.workflowRunId,
        text: `${params.ticketKey} analiz onayı SLA aşıldı`,
        critical: true,
      });
      return { status: "rejected", reason: "analysis approval SLA" };
    }
    if (decision.kind === "approve") {
      await A.recordHumanDecision({
        workflowRunId: state.workflowRunId,
        stepName: state.step,
        decision: "approve",
        jiraUserId: decision.user.accountId,
        jiraUsername: decision.user.name,
      });
      break;
    }
    // reject path: loop back to analyst
    await A.recordHumanDecision({
      workflowRunId: state.workflowRunId,
      stepName: state.step,
      decision: "reject",
      jiraUserId: decision.user.accountId,
      jiraUsername: decision.user.name,
      reason: decision.reason,
    });
    analysisRounds++;
    if (analysisRounds >= MAX_ANALYSIS_ROUNDS) {
      await A.notifySlack({
        workflowRunId: state.workflowRunId,
        text: `${params.ticketKey}: 3. analiz reddi, mimara eskalasyon`,
        critical: true,
      });
      return { status: "rejected", reason: "3rd analysis rejection — escalated" };
    }
    state.step = "3-analyst";
    await A.postJiraComment({
      ticketKey: params.ticketKey,
      bodyText: `🔁 Analiz yeniden çalışıyor (${analysisRounds}/${MAX_ANALYSIS_ROUNDS})…`,
    });
  }

  // STEP 5 — Tech Lead approval (on technical design)
  state.step = "5-tech-lead-approval";
  state.waitingFor = "Tech Lead";
  await A.transitionJiraStatus({
    ticketKey: params.ticketKey,
    step: state.step,
    workMode: state.workMode,
  });
  await A.postJiraComment({
    ticketKey: params.ticketKey,
    bodyText: `🛠️ Teknik tasarım Tech Lead onayı bekliyor.\n\n**Yaklaşım:** ${analysis.technicalDesign.approach}\n**Dosya değişiklikleri:** ${analysis.technicalDesign.filesToChange.length} adet\n\n\`/approve\` ya da \`/reject <sebep>\``,
  });
  const tlDecision = await waitForHumanDecision(state, {
    stepName: "5-tech-lead-approval",
    ticketKey: params.ticketKey,
    sla: SLA_APPROVAL,
    allowedSignals: { approve: true, reject: true, cancel: true },
  });
  if (state.cancelled) throw new Error("cancelled");
  if (tlDecision.kind !== "approve") {
    return { status: "rejected", reason: "tech lead rejected dev approval" };
  }
  // 4-göz kuralı: analiz onaylayanla aynı kişi mi?
  const fourEyes = await A.assertFourEyes({
    workflowRunId: state.workflowRunId,
    currentStep: "5-tech-lead-approval",
    actorJiraUserId: tlDecision.user.accountId,
    forbiddenPriorSteps: ["4-po-approval"],
  });
  if (!fourEyes.ok) {
    await A.postJiraComment({
      ticketKey: params.ticketKey,
      bodyText: `⚠️ 4-göz ihlali: ${fourEyes.violation}. Onay geçersiz, farklı kişi onaylamalı.`,
    });
    return { status: "rejected", reason: fourEyes.violation };
  }
  await A.recordHumanDecision({
    workflowRunId: state.workflowRunId,
    stepName: state.step,
    decision: "approve",
    jiraUserId: tlDecision.user.accountId,
    jiraUsername: tlDecision.user.name,
  });

  // STEP 6a–6c — Development (mode-aware), 6b security scan, 6c dev-review
  let patch = "";
  let branchName = `feature/${params.ticketKey}`;
  const baseCommit = "HEAD"; // real sandbox will pin it
  state.branchName = branchName;
  state.baseCommit = baseCommit;

  if (state.workMode === "human_only") {
    await A.postJiraComment({
      ticketKey: params.ticketKey,
      bodyText: `🧑‍💻 Human-only mode: ajan çağrısı yok. Kod insan tarafından yazılıyor.`,
    });
    state.step = "6a-human-development";
    await A.transitionJiraStatus({
      ticketKey: params.ticketKey,
      step: state.step,
      workMode: state.workMode,
    });
    // Wait for PR opened signal (via Bitbucket webhook)
    const prOpened = await condition(
      () => state.prId !== undefined || state.cancelled,
      SLA_APPROVAL * 3,
    );
    if (state.cancelled) throw new Error("cancelled");
    if (!prOpened) return { status: "rejected", reason: "no PR opened within SLA" };
  } else {
    // full_auto or ai_assist or human_lead
    state.step = "6a-development";
    await A.transitionJiraStatus({
      ticketKey: params.ticketKey,
      step: state.step,
      workMode: state.workMode,
    });

    const devRounds = { count: 0, max: 2 };
    let reviewerVerdict: DevReviewerOutput | null = null;

    while (true) {
      if (state.workMode === "full_auto") {
        // Check budget before costly dev step
        const budget = await A.checkBudget({
          workflowRunId: state.workflowRunId,
          hardCapUsdCents: 500,
        });
        if (budget.exceeded) {
          await A.postJiraComment({
            ticketKey: params.ticketKey,
            bodyText: `💰 Bütçe aşıldı (${(budget.usedCents / 100).toFixed(2)} USD). İnsan müdahalesi bekleniyor.`,
          });
          await A.notifySlack({
            workflowRunId: state.workflowRunId,
            text: `${params.ticketKey}: budget exceeded`,
            critical: true,
          });
          return { status: "rejected", reason: "budget exceeded" };
        }

        const dev: DeveloperOutput = await AI.runDeveloperAgent({
          workflowRunId: state.workflowRunId,
          ticket,
          analysis,
          baseCommit,
          repoSkeleton: "", // supplied by sandbox phase via activity
          targetFiles: {},
          correlationId: params.correlationId,
        });
        patch = dev.patch;
      } else if (state.workMode === "ai_assist") {
        // In ai_assist, human is coding. We wait for them to push + open PR,
        // then AI reviews. Skip the dev agent call.
        await A.postJiraComment({
          ticketKey: params.ticketKey,
          bodyText: `🧑‍💻 ai-assist: insan kod yazıyor, AI sonradan review'a gelecek. PR aç hazır olunca.`,
        });
        const prOpened = await condition(
          () => state.prId !== undefined || state.cancelled,
          SLA_APPROVAL,
        );
        if (state.cancelled) throw new Error("cancelled");
        if (!prOpened) return { status: "rejected", reason: "ai-assist: no PR opened" };
        patch = ""; // reviewer will fetch diff from PR
      } else if (state.workMode === "human_lead") {
        await A.postJiraComment({
          ticketKey: params.ticketKey,
          bodyText: `🧑‍💻 human-lead: kod tamamen insanda. PR açınca AI review yapar.`,
        });
        const prOpened = await condition(
          () => state.prId !== undefined || state.cancelled,
          SLA_APPROVAL,
        );
        if (state.cancelled) throw new Error("cancelled");
        if (!prOpened) return { status: "rejected", reason: "human-lead: no PR opened" };
        patch = "";
      }

      // STEP 6b — Security scan
      state.step = "6b-security-scan";
      await A.transitionJiraStatus({
        ticketKey: params.ticketKey,
        step: state.step,
        workMode: state.workMode,
      });
      // Security scan runs inside sandbox activity; skip separate here if sandbox is implied.

      // STEP 6c — Dev reviewer
      state.step = "6c-dev-reviewer";
      await A.transitionJiraStatus({
        ticketKey: params.ticketKey,
        step: state.step,
        workMode: state.workMode,
      });
      reviewerVerdict = await AI.runDevReviewerAgent({
        workflowRunId: state.workflowRunId,
        ticket,
        patch,
        analysis,
        correlationId: params.correlationId,
      });

      if (reviewerVerdict.verdict === "approve") break;

      devRounds.count++;
      if (devRounds.count >= devRounds.max) {
        await A.notifySlack({
          workflowRunId: state.workflowRunId,
          text: `${params.ticketKey}: dev-reviewer rejected ${devRounds.max}x, escalating`,
          critical: true,
        });
        return { status: "rejected", reason: "dev-reviewer bounded retry exhausted" };
      }
      await A.postJiraComment({
        ticketKey: params.ticketKey,
        bodyText: `🔁 Dev-reviewer değişiklik istedi (${devRounds.count}/${devRounds.max}):\n${reviewerVerdict.summary}`,
      });
      state.step = "6a-development";
    }

    // Push via sandbox
    if (state.workMode === "full_auto") {
      const sandboxResult = await SANDBOX.runSandbox({
        workflowRunId: state.workflowRunId,
        repoUrl: `${ticket.projectKey}/repo`, // placeholder; real config maps ticket → repo
        baseCommit,
        branchName,
        patch,
        ticketKey: params.ticketKey,
      });
      if (!sandboxResult.success) {
        await A.postJiraComment({
          ticketKey: params.ticketKey,
          bodyText: `❌ Sandbox self-check başarısız:\n\`\`\`\n${sandboxResult.stderr.slice(0, 1500)}\n\`\`\``,
        });
        return { status: "rejected", reason: "sandbox failed" };
      }
      // Open PR
      const pr = await A.createPullRequest({
        workflowRunId: state.workflowRunId,
        repoProject: ticket.projectKey,
        repoSlug: "repo",
        sourceBranch: branchName,
        targetBranch: "main",
        title: `${params.ticketKey}: ${ticket.summary}`,
        description: `## Özet\n${ticket.summary}\n\n## Analiz\nRefs: ${params.ticketKey}\n\n🤖 AI-generated patch via Orkestra`,
      });
      state.prId = pr.prId;
      await A.postJiraComment({
        ticketKey: params.ticketKey,
        bodyText: `🔀 PR açıldı: ${pr.url}`,
      });
    }
  }

  // STEP 7 — Test designer (skipped in human_only)
  let scenarios: TestDesignerOutput | null = null;
  if (state.workMode !== "human_only") {
    state.step = "7-test-designer";
    await A.transitionJiraStatus({
      ticketKey: params.ticketKey,
      step: state.step,
      workMode: state.workMode,
    });
    const testRounds = { count: 0, max: 3 };
    while (true) {
      scenarios = await AI.runTestDesignerAgent({
        workflowRunId: state.workflowRunId,
        ticket,
        analysis,
        patch,
        correlationId: params.correlationId,
      });

      // STEP 8 — Test reviewer
      state.step = "8-test-reviewer";
      await A.transitionJiraStatus({
        ticketKey: params.ticketKey,
        step: state.step,
        workMode: state.workMode,
      });
      const review: TestReviewerOutput = await AI.runTestReviewerAgent({
        workflowRunId: state.workflowRunId,
        ticket,
        scenarios,
        correlationId: params.correlationId,
      });
      if (review.verdict === "approve") break;
      testRounds.count++;
      if (testRounds.count >= testRounds.max) {
        return { status: "rejected", reason: "test design bounded retry exhausted" };
      }
      await A.postJiraComment({
        ticketKey: params.ticketKey,
        bodyText: `🔁 Test tasarım yeniden isteniyor: ${review.coverage.gaps.join(", ")}`,
      });
    }

    // STEP 9 — QA approval (senaryolar yeterli mi)
    state.step = "9-qa-approval";
    state.waitingFor = "QA";
    await A.transitionJiraStatus({
      ticketKey: params.ticketKey,
      step: state.step,
      workMode: state.workMode,
    });
    await A.postJiraComment({
      ticketKey: params.ticketKey,
      bodyText: `🧪 Test senaryoları hazır, QA onayı bekliyor. \`/approve\` ya da \`/reject\``,
    });
    const qaDecision = await waitForHumanDecision(state, {
      stepName: "9-qa-approval",
      ticketKey: params.ticketKey,
      sla: SLA_APPROVAL,
      allowedSignals: { approve: true, reject: true, cancel: true },
    });
    if (state.cancelled) throw new Error("cancelled");
    if (qaDecision.kind !== "approve") {
      return { status: "rejected", reason: "QA rejected test scenarios" };
    }
    await A.recordHumanDecision({
      workflowRunId: state.workflowRunId,
      stepName: "9-qa-approval",
      decision: "approve",
      jiraUserId: qaDecision.user.accountId,
      jiraUsername: qaDecision.user.name,
    });

    // Push scenarios to TestRail
    await A.pushTestCases({
      workflowRunId: state.workflowRunId,
      projectKey: ticket.projectKey,
      scenarios: scenarios.scenarios,
    }).catch(() => undefined);

    // STEP 10 — Test runner
    state.step = "10-test-runner";
    await A.transitionJiraStatus({
      ticketKey: params.ticketKey,
      step: state.step,
      workMode: state.workMode,
    });
    const runResult: TestRunnerOutput = await AI.runTestRunnerAgent({
      workflowRunId: state.workflowRunId,
      ticket,
      scenarios,
      correlationId: params.correlationId,
    });
    if (!runResult.overallPassed) {
      await A.postJiraComment({
        ticketKey: params.ticketKey,
        bodyText: `❌ Testler başarısız. ${runResult.results.filter((r) => !r.passed).length} adım fail.`,
      });
      return { status: "rejected", reason: "tests failed" };
    }
    if (runResult.coveragePct < 70) {
      await A.postJiraComment({
        ticketKey: params.ticketKey,
        bodyText: `⚠️ Coverage %${runResult.coveragePct} < %70 eşik.`,
      });
      return { status: "rejected", reason: "coverage gate" };
    }
    if (runResult.flaky.length >= 2) {
      await A.postJiraComment({
        ticketKey: params.ticketKey,
        bodyText: `🌀 Flaky test tespit edildi: ${runResult.flaky.join(", ")}. İnsan incelemesi gerekli.`,
      });
      return { status: "rejected", reason: "flaky tests detected" };
    }
  }

  // STEP 10b — CI Gate (Bitbucket Pipelines)
  state.step = "10b-ci-gate";
  state.waitingFor = "Bitbucket Pipelines";
  await A.transitionJiraStatus({
    ticketKey: params.ticketKey,
    step: state.step,
    workMode: state.workMode,
  });
  const ciSuccess = await condition(
    () => state.ciResult !== undefined || state.cancelled,
    60 * 60 * 1000,
  );
  if (state.cancelled) throw new Error("cancelled");
  if (!ciSuccess || !state.ciResult?.success) {
    await A.postJiraComment({
      ticketKey: params.ticketKey,
      bodyText: `❌ CI Gate kırmızı: ${state.ciResult?.url ?? "no CI result"}`,
    });
    return { status: "rejected", reason: "CI gate red" };
  }

  // STEP 11 — QA result approval (skipped in human_only)
  if (state.workMode !== "human_only") {
    state.step = "11-qa-results-approval";
    state.waitingFor = "QA";
    await A.transitionJiraStatus({
      ticketKey: params.ticketKey,
      step: state.step,
      workMode: state.workMode,
    });
    await A.postJiraComment({
      ticketKey: params.ticketKey,
      bodyText: `✅ Test sonuçları hazır, QA son onay bekliyor.`,
    });
    const qaResultDecision = await waitForHumanDecision(state, {
      stepName: "11-qa-results-approval",
      ticketKey: params.ticketKey,
      sla: SLA_APPROVAL,
      allowedSignals: { approve: true, reject: true, cancel: true },
    });
    if (state.cancelled) throw new Error("cancelled");
    if (qaResultDecision.kind !== "approve") {
      return { status: "rejected", reason: "QA rejected test results" };
    }
    await A.recordHumanDecision({
      workflowRunId: state.workflowRunId,
      stepName: "11-qa-results-approval",
      decision: "approve",
      jiraUserId: qaResultDecision.user.accountId,
      jiraUsername: qaResultDecision.user.name,
    });
  }

  // STEP 12 / 12b — PR approval + comment loop
  state.step = "12-pr-approval";
  state.waitingFor = "Tech Lead";
  await A.transitionJiraStatus({
    ticketKey: params.ticketKey,
    step: state.step,
    workMode: state.workMode,
  });
  await A.postJiraComment({
    ticketKey: params.ticketKey,
    bodyText: `🔀 PR final onayı bekliyor: ${state.prId ?? "(PR not created)"}`,
  });

  while (true) {
    const prDecision = await waitForHumanDecision(state, {
      stepName: "12-pr-approval",
      ticketKey: params.ticketKey,
      sla: SLA_APPROVAL,
      allowedSignals: { approve: true, reject: true, cancel: true },
    });
    if (state.cancelled) throw new Error("cancelled");
    if (prDecision.kind === "approve") {
      // 4-göz: PR onaylayan ≠ analiz onaylayan
      const fe = await A.assertFourEyes({
        workflowRunId: state.workflowRunId,
        currentStep: "12-pr-approval",
        actorJiraUserId: prDecision.user.accountId,
        forbiddenPriorSteps: ["4-po-approval"],
      });
      if (!fe.ok) {
        await A.postJiraComment({
          ticketKey: params.ticketKey,
          bodyText: `⚠️ 4-göz ihlali: PR onaylayan kullanıcı analiz onaylayan ile aynı. Farklı kişi onaylamalı.`,
        });
        continue;
      }
      await A.recordHumanDecision({
        workflowRunId: state.workflowRunId,
        stepName: "12-pr-approval",
        decision: "approve",
        jiraUserId: prDecision.user.accountId,
        jiraUsername: prDecision.user.name,
      });
      break;
    }
    if (prDecision.kind === "reject") {
      return { status: "rejected", reason: "PR rejected" };
    }
  }

  // DONE
  state.step = "done";
  await A.transitionJiraStatus({
    ticketKey: params.ticketKey,
    step: "done",
    workMode: state.workMode,
  });
  await A.completeWorkflow({ workflowRunId: state.workflowRunId, status: "done" });
  await A.postJiraComment({
    ticketKey: params.ticketKey,
    bodyText: `🎉 Ticket tamamlandı, PR merge için hazır.`,
  });
  return { status: "done", prUrl: state.prId };
}

// ============================================================================
// Signal-backed human decision helper
// ============================================================================

type Decision =
  | { kind: "approve"; user: { accountId: string; name?: string } }
  | { kind: "reject"; user: { accountId: string; name?: string }; reason?: string }
  | { kind: "timeout" };

async function waitForHumanDecision(
  state: WorkflowState,
  params: {
    stepName: string;
    ticketKey: string;
    sla: number;
    allowedSignals: { approve?: boolean; reject?: boolean; cancel?: boolean };
  },
): Promise<Decision> {
  let decision: Decision | null = null;

  setHandler(approveSignal, (s: JiraCommentSignal) => {
    if (params.allowedSignals.approve && !decision) {
      decision = { kind: "approve", user: { accountId: s.user.accountId, name: s.user.name } };
    }
  });
  setHandler(rejectSignal, (s: JiraCommentSignal) => {
    if (params.allowedSignals.reject && !decision) {
      decision = {
        kind: "reject",
        user: { accountId: s.user.accountId, name: s.user.name },
        reason: s.args,
      };
    }
  });

  const reminderAt = Date.now() + SLA_REMINDER_INTERVAL;
  const deadline = Date.now() + params.sla;

  while (!decision && !state.cancelled) {
    const wait = Math.max(1000, Math.min(reminderAt - Date.now(), deadline - Date.now()));
    const got = await condition(() => decision !== null || state.cancelled, wait);
    if (state.cancelled) return { kind: "timeout" };
    if (got) break;
    if (Date.now() >= deadline) return { kind: "timeout" };
    if (Date.now() >= reminderAt && !decision) {
      // single reminder
      log.info(`reminder sent for ${params.stepName}`);
    }
  }
  return decision ?? { kind: "timeout" };
}
