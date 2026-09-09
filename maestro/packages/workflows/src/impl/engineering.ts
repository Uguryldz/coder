import { NonEmpty, type TicketKey } from "@maestro/contracts";
import type { AgentTurnResult, SessionReport } from "@maestro/execution";
import { buildLivingSummary } from "@maestro/memory";
import { z } from "zod";
import type { EngineeringResult, ReviewResult, TestRunResult } from "../activities.js";
import type { ActivityDeps, RunContext } from "./deps.js";
import { engineerVariantOf } from "./deps.js";
import { guardModelCall, handOver, quotaWait, resolveOutcome } from "./outcome.js";
import { audit, record } from "./record.js";
import { developerBrief, loadAnalysis, planDeviations, ruleChecklist } from "./brief.js";
import { commentsBlock, readHumanComments } from "./comments.js";
import { roleVariantId, trainingFor } from "./persona.js";

/**
 * Steps 6a, 6c, 7, 8 and 10: the doing role and the roles that judge it.
 *
 * Every turn goes through `@maestro/execution`, which is where the M52
 * protected-path gate and the M54 strike counter live. This file's job is to
 * carry the resume token faithfully (M30) and to translate the turn's outcome
 * into the two facts the workflow acts on: did it work, and must a human take
 * over.
 */

export const ReviewVerdict = z.object({
  approved: z.boolean(),
  findings: z.array(NonEmpty.max(2000)).max(50).default([]),
});

/**
 * The VERIFIER's digest (step 6c). A superset of `ReviewVerdict` on purpose:
 * a deployment whose model still answers with the two old fields is not
 * broken, it is just not yet rule-by-rule. `rules` is the customer's
 * PASS/FAIL table — one row per business rule, never a blanket sentence.
 */
export const VerificationVerdict = ReviewVerdict.extend({
  build: z
    .object({ status: z.enum(["ok", "fail", "skipped"]), detail: z.string().max(2000).default("") })
    .optional(),
  rules: z
    .array(
      z.object({
        rule: NonEmpty.max(800),
        status: z.enum(["PASS", "FAIL", "BELIRSIZ"]),
        evidence: z.string().max(1500).default(""),
      }),
    )
    .max(100)
    .default([]),
  brokenTests: z.array(NonEmpty.max(300)).max(50).default([]),
});

const VERIFY_DIGEST_RULES: readonly string[] = [
  "'report' doğrulayıcı ajanın son mesajı. Oradaki derleme sonucunu 'build' alanına (ok/fail/skipped + hata özeti), iş kuralı tablosunu 'rules' alanına (her kural için PASS/FAIL/BELIRSIZ + kanıt), kırılan testleri 'brokenTests' alanına, diğer bulguları 'findings' alanına aktar.",
  "'rules' listesi 'businessRules' girdisindeki HER kuralı kapsamalı; raporda bir kuraldan söz edilmiyorsa BELIRSIZ yaz. Raporda olmayan bir sonucu UYDURMA.",
  "'approved' yalnız derleme ok/skipped, hiçbir kural FAIL değil ve blocker/major bulgu yoksa true.",
];

export const TestDesign = z.object({ scenarios: z.number().int().nonnegative() });

export const TestRunDigest = z.object({
  total: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  coveragePct: z.number().min(0).max(100),
});

/** The context a NEW session opens with (M30); a resumed one gets the task only. */
async function turnContext(deps: ActivityDeps, run: RunContext, task: string) {
  const entries = await deps.memory.store.list(run.runId);
  return {
    ticketKey: run.ticket,
    runId: run.runId,
    task,
    journal: entries,
    livingSummary: entries.length === 0 ? null : buildLivingSummary(run.runId, entries),
    workspace: {
      path: run.workspacePath,
      present: run.workspacePresent,
      branch: run.branch,
      baseSha: null,
      dirtyFiles: [],
    },
    protectedPaths: run.protectedPaths,
    mcpServers: ["workspace", "jira", "ado"],
  };
}

/**
 * One agent turn, and the four ways it can end other than "done".
 *
 * `queued` is a retryable failure so Temporal parks the run until the quota
 * window opens (M55); `blocked` is permanent (M18); `degraded` and a strike
 * limit both hand the ticket over, which is a RESULT, not a failure — the
 * workflow decides what to do with it.
 */
async function finishTurn(
  deps: ActivityDeps,
  run: RunContext,
  outcome: AgentTurnResult,
  what: string,
): Promise<{ report: SessionReport; handoverReason?: string } | { handoverReason: string }> {
  switch (outcome.status) {
    case "queued":
      throw quotaWait(outcome.resumeAt, deps.now());
    case "blocked":
      // O4: the handover is real and fully recorded, so it must be REPORTED as
      // a handover. Throwing here instead closed the run as a failure, and the
      // ticket showed up in Studio as "başarısız" while it was in fact sitting
      // correctly in a human's queue. The compliance decision is on the record
      // either way; what changes is that the workflow can now act on it.
      await handOver(deps, run, `${what}: ${outcome.messageKey}`, `blocked:${what}`);
      return { handoverReason: `${what}: ${outcome.messageKey}` };
    case "degraded":
      await deps.runs.patch(run.ticket, { mode: "ai_assist" });
      return { handoverReason: `ai_assist (M97): ${outcome.messageKey}` };
    case "ok":
      return { report: outcome.report };
    case "failed": {
      // M52 is absolute: an illegal diff stops the flow on the FIRST offence,
      // it does not get three tries. A red build gets the strike ladder.
      const reason =
        outcome.reason === "protected_path"
          ? `korumalı yol ihlali (M52): ${outcome.report.protectedViolations.map((v) => v.path).join(", ")}`
          : outcome.handover.handover
            ? `${outcome.handover.count}/${outcome.handover.limit} tur ilerleme yok (M54)`
            : undefined;
      return reason === undefined ? { report: outcome.report } : { report: outcome.report, handoverReason: reason };
    }
  }
}

/** Step 6a / 12b / CI fix — always the SAME session when a token exists (M30). */
export async function runEngineering(
  deps: ActivityDeps,
  ticket: TicketKey,
  resumeToken: string | null,
  task: string,
  attempt = 1,
): Promise<EngineeringResult> {
  const run = await deps.runs.get(ticket);
  const outcome = await deps.execution.runTurn({
    context: await turnContext(deps, run, await engineeringTask(deps, run, task, resumeToken === null)),
    dataClass: run.dataClass,
    // The MÜHENDİS agent, not the analyst's. Every call in this file is on the
    // engineering half of the run — the code-writing turn, both reviewers, the
    // test design and the test digest — and until migration 0022 they all read
    // `run.variantId`, which `activeAnalystVariantId` had planted. An admin who
    // gave the engineer its own model in "Ajan tanımları" got the analyst's
    // model here, with nothing anywhere saying so. `engineerVariantOf` falls
    // back to `run.variantId` for a run opened before the pin existed.
    variantId: engineerVariantOf(run),
    // The token the WORKFLOW holds wins: it is the only copy that survives a
    // redeploy, and the store's copy may be a retry's stale read.
    ...(resumeToken === null ? {} : { resumeToken }),
    verification: run.verification,
  });
  const finished = await finishTurn(deps, run, outcome, "engineering");

  if (!("report" in finished)) {
    return { ok: false, resumeToken: resumeToken ?? "", changedFiles: 0, diffSummary: "", handoverReason: finished.handoverReason };
  }
  const { report } = finished;
  await deps.runs.patch(ticket, { resumeToken: report.resumeToken, workspacePresent: true });
  await record(deps, run, {
    kind: "engineering",
    actor: "ai",
    title: "geliştirme turu",
    detail: `${report.diff.files} dosya · +${report.diff.insertions} -${report.diff.deletions}`,
    key: `engineering:${attempt}:${report.at}`,
  });
  // "Plan Sapması": the developer may leave the plan, never silently. Each
  // line it wrote becomes its own journal entry, so the reviewer, the gate
  // and the evidence package all see what changed against the approved plan.
  const deviations = planDeviations(report.finalText);
  for (const [index, deviation] of deviations.entries()) {
    await record(deps, run, {
      kind: "engineering",
      actor: "ai",
      title: "plan sapması",
      detail: deviation,
      key: `deviation:${attempt}:${report.at}:${String(index)}`,
    });
  }
  const ok = finished.handoverReason === undefined && report.protectedViolations.length === 0;
  return {
    ok,
    resumeToken: report.resumeToken,
    changedFiles: report.diff.files,
    diffSummary: `+${report.diff.insertions} -${report.diff.deletions}`,
    ...(finished.handoverReason === undefined ? {} : { handoverReason: finished.handoverReason }),
  };
}

/** Steps 6c and 8 — the AI reviews (a degraded gateway means "not approved"). */
/**
 * What the developer agent is told. The customer's developer brief (rules:
 * follow the plan, mimic the sibling file, log every "PLAN SAPMASI") goes out
 * on every turn — a resumed session receives only the task. The plan itself
 * (files, endpoint contract, DTO fields, business rules) goes out once, with
 * the fresh session, from the stored analysis; without a stored analysis the
 * turn reads exactly as it did before this brief existed.
 *
 * ── TİCKET YORUMLARI — NEDEN BURADA ─────────────────────────────────────────
 * `developerBrief` açık soruların altına "cevap ticket yorumlarında" yazıyor.
 * O cümle bir YALANDI: bu dosyada yorum okuyan tek satır yoktu, yani ajana
 * kendisine hiç verilmemiş bir yere bakması söyleniyordu. Sonuç, kapıda
 * cevaplanmış bir sorunun geliştirici turunda YİNE açık sayılması — insan
 * cevabı yazmış, kod yazan onu görmemiş.
 *
 * Yalnız FRESH oturumda, `developerBrief`in kendisiyle aynı gerekçeyle: devam
 * eden bir turda o metin zaten oturumun geçmişinde duruyor, tekrar göndermek
 * her turda büyüyen bir prompt ve modelin aynı bağlamı iki kez okuması demek.
 *
 * Yorumlar açık soru OLMASA DA gider: insan kapıda yalnız soruları cevaplamaz —
 * kapsam daraltır, bir karardan vazgeçer, bir dosyayı işaret eder. Gürültü
 * sınırı `humanCommentsOf`un kendi limiti (son 10 yorum, her biri 2000 karakter)
 * — burada ikinci bir sınır koymak, geliştiricinin analizden farklı bir yorum
 * kümesi görmesi olurdu.
 *
 * Fail-soft: `readHumanComments` ATMAZ (bkz. `comments.ts`). Sürücü yoksa ya da
 * Jira düşerse liste boş döner ve brifing bugünküyle bit bit aynı kalır.
 */
async function engineeringTask(deps: ActivityDeps, run: RunContext, task: string, fresh: boolean): Promise<string> {
  // The developer agent's TRAINING (its Studio persona, else the shipped
  // text) goes out on every turn, with the one-line task framing; the plan
  // itself only with a fresh session.
  const training = await trainingFor(deps, run, "engineer");
  const rules = deps.translate(run.locale, "agent.engineering_brief", { ticket: run.ticket });
  const doc = fresh ? await loadAnalysis(deps, run) : null;
  // Uyarı satırı "geliştirme" der: başarısız bir okumada operatör kendi adımına
  // baksın, intake'e ya da analize değil.
  const comments = fresh
    ? commentsBlock(await readHumanComments(deps, run.ticket, undefined, "geliştirme"))
    : undefined;
  return [
    training,
    rules,
    ...(doc === null ? [] : [developerBrief(doc)]),
    ...(comments === undefined ? [] : [comments]),
    `## Bu turun görevi\n${task}`,
  ]
    .filter((part) => part !== "")
    .join("\n\n");
}

/**
 * Step 6c — the VERIFIER agent (customer brief): a fresh, separate session in
 * the workspace that runs the build, checks every business rule one by one
 * and runs the test suite — reporting, never fixing. Null when the run has
 * no workspace or the session could not be opened; the caller then falls
 * back to the ticket-only structured review this step always had.
 */
/**
 * The verifier in the SANDBOX (same fleet as the developer): a fresh turn on
 * the verifier's agent with the run's verification commands, so "run the
 * build and the tests" is a command it can actually execute; the command
 * results go into its report. Null when there is no sandbox fleet or the
 * turn could not open — the caller falls back to the read-only workspace
 * session, which can read the diff and check rules but cannot build.
 */
async function verifierTurn(
  deps: ActivityDeps,
  run: RunContext,
  task: string,
): Promise<{ finalText: string } | null> {
  const variantId = await roleVariantId(deps, run, "dev_reviewer");
  let outcome: AgentTurnResult;
  try {
    outcome = await deps.execution.runTurn({
      context: await turnContext(deps, run, task),
      dataClass: run.dataClass,
      variantId,
      verification: run.verification,
    });
  } catch {
    return null;
  }
  if (outcome.status !== "ok") return null;
  const report = outcome.report;
  const commands = report.commands.map(
    (c) => `- ${c.name} (${c.command.join(" ")}): exit ${String(c.exitCode)}${c.stderrTail.trim() === "" ? "" : ` — ${c.stderrTail.trim().slice(0, 400)}`}`,
  );
  return {
    finalText: [report.finalText, "", "## Sandbox'ta çalıştırılan doğrulama komutları", ...(commands.length === 0 ? ["- (tanımlı komut yok)"] : commands)].join("\n"),
  };
}

async function verifierSession(
  deps: ActivityDeps,
  run: RunContext,
  rules: readonly string[],
): Promise<{ finalText: string } | null> {
  if (run.workspacePath.trim() === "") return null;
  const commands = run.verification.map((spec) => `- ${spec.name}: ${spec.command.join(" ")}`).join("\n");
  // The verifier's own agent definition (role `dev_reviewer`): training
  // first, then the task with this run's rules and commands.
  const training = await trainingFor(deps, run, "dev_reviewer");
  const verifierVariant = await roleVariantId(deps, run, "dev_reviewer");
  let outcome: Awaited<ReturnType<ActivityDeps["llm"]["agentSession"]>>;
  try {
    outcome = await deps.llm.agentSession({
      workspacePath: run.workspacePath,
      task: `${training}\n\n${deps.translate(run.locale, "agent.verify_task", {
        ticket: run.ticket,
        rules: rules.length === 0 ? "- (analizde iş kuralı yok — kabul kriterlerini ticket'tan al)" : rules.join("\n"),
        commands: commands === "" ? "- (tanımlı komut yok)" : commands,
      })}`,
      mcpServers: [],
      dataClass: run.dataClass,
      variantId: verifierVariant,
    });
  } catch {
    return null;
  }
  const resolved = await resolveOutcome(deps, run, "verify", outcome);
  return resolved.status === "degraded" ? null : { finalText: resolved.value.finalText };
}

/** The verifier's table as one journal detail: build, then one line per rule. */
function verificationTable(verdict: z.infer<typeof VerificationVerdict>): string {
  const build =
    verdict.build === undefined
      ? []
      : [`derleme: ${verdict.build.status}${verdict.build.detail === "" ? "" : ` — ${verdict.build.detail}`}`];
  const rules = verdict.rules.map(
    (row) => `${row.status} — ${row.rule}${row.evidence === "" ? "" : ` (${row.evidence})`}`,
  );
  const broken = verdict.brokenTests.length === 0 ? [] : [`kırılan testler: ${verdict.brokenTests.join(", ")}`];
  return [...build, ...rules, ...broken, ...verdict.findings].join("\n");
}

async function verifyChanges(deps: ActivityDeps, ticket: TicketKey, attempt: number): Promise<ReviewResult> {
  const run = await deps.runs.get(ticket);
  const doc = await loadAnalysis(deps, run);
  const rules = doc === null ? [] : ruleChecklist(doc);
  // Sandbox first (build + tests really run), read-only workspace session second.
  const commands = run.verification.map((spec) => `- ${spec.name}: ${spec.command.join(" ")}`).join("\n");
  const verifyTask = `${await trainingFor(deps, run, "dev_reviewer")}\n\n${deps.translate(run.locale, "agent.verify_task", {
    ticket: run.ticket,
    rules: rules.length === 0 ? "- (analizde iş kuralı yok — kabul kriterlerini ticket'tan al)" : rules.join("\n"),
    commands: commands === "" ? "- (tanımlı komut yok)" : commands,
  })}`;
  const session = (await verifierTurn(deps, run, verifyTask)) ?? (await verifierSession(deps, run, rules));
  if (session === null) return review(deps, ticket, "dev_reviewer", "diff-review", attempt);
  const verifierVariant = await roleVariantId(deps, run, "dev_reviewer");
  const outcome = await guardModelCall(deps, run, "dev_reviewer", () =>
    deps.llm.generateObject(
      {
        role: "dev_reviewer",
        variantId: verifierVariant,
        dataClass: run.dataClass,
        schemaName: "diff-review",
        input: { ticket, rules: VERIFY_DIGEST_RULES, businessRules: rules, report: session.finalText },
      },
      VerificationVerdict,
    ),
  );
  const resolved = await resolveOutcome(deps, run, "dev_reviewer", outcome);
  if (resolved.status === "degraded") {
    return { approved: false, findings: [`ai_assist (M97): ${resolved.messageKey}`] };
  }
  const verdict = resolved.value;
  const failed = verdict.rules.filter((row) => row.status === "FAIL");
  const buildRed = verdict.build?.status === "fail";
  const approved = verdict.approved && !buildRed && failed.length === 0 && verdict.brokenTests.length === 0;
  const findings = [
    ...(buildRed ? [`derleme kırmızı: ${verdict.build?.detail ?? ""}`] : []),
    ...failed.map((row) => `${row.rule}: FAIL${row.evidence === "" ? "" : ` — ${row.evidence}`}`),
    ...verdict.brokenTests.map((test) => `kırılan test: ${test}`),
    ...verdict.findings,
  ];
  await record(deps, run, {
    kind: "review",
    actor: "ai",
    title: approved ? "doğrulama onaylandı" : "doğrulama bulguları",
    detail: verificationTable(verdict),
    key: `dev_reviewer:${attempt}`,
  });
  return { approved, findings };
}

async function review(
  deps: ActivityDeps,
  ticket: TicketKey,
  role: "dev_reviewer" | "test_reviewer",
  schemaName: string,
  attempt: number,
): Promise<ReviewResult> {
  const run = await deps.runs.get(ticket);
  const outcome = await guardModelCall(deps, run, role, () =>
    deps.llm.generateObject(
      { role, variantId: engineerVariantOf(run), dataClass: run.dataClass, schemaName, input: { ticket } },
      ReviewVerdict,
    ),
  );
  const resolved = await resolveOutcome(deps, run, role, outcome);
  if (resolved.status === "degraded") {
    return { approved: false, findings: [`ai_assist (M97): ${resolved.messageKey}`] };
  }
  await record(deps, run, {
    kind: role === "dev_reviewer" ? "review" : "test_review",
    actor: "ai",
    title: resolved.value.approved ? "inceleme onaylandı" : "inceleme bulguları",
    detail: resolved.value.findings.join("\n"),
    // Keyed on the ROUND, not on the verdict: two rounds that both came back
    // with the same two findings are two events, and the journal must show both.
    key: `${role}:${attempt}`,
  });
  return { approved: resolved.value.approved, findings: [...resolved.value.findings] };
}

export const reviewDiff = (deps: ActivityDeps, ticket: TicketKey, attempt = 1): Promise<ReviewResult> =>
  verifyChanges(deps, ticket, attempt);

export const reviewTests = (
  deps: ActivityDeps,
  ticket: TicketKey,
  attempt = 1,
): Promise<ReviewResult> => review(deps, ticket, "test_reviewer", "test-review", attempt);

export async function designTests(
  deps: ActivityDeps,
  ticket: TicketKey,
  attempt = 1,
): Promise<{ scenarios: number }> {
  const run = await deps.runs.get(ticket);
  const doc = await loadAnalysis(deps, run);
  const outcome = await guardModelCall(deps, run, "test-design", () =>
    deps.llm.generateObject(
      {
        role: "test_designer",
        variantId: engineerVariantOf(run),
        dataClass: run.dataClass,
        schemaName: "test-design",
        // The designer writes a scenario per acceptance criterion, so it gets
        // the criteria and the business rules from the stored analysis. No
        // stored analysis: the input is what it always was.
        input: {
          ticket,
          ...(doc === null ? {} : { acceptanceCriteria: doc.acceptanceCriteria, businessRules: doc.businessRules }),
        },
      },
      TestDesign,
    ),
  );
  const resolved = await resolveOutcome(deps, run, "test-design", outcome);
  const scenarios = resolved.status === "degraded" ? 0 : resolved.value.scenarios;
  await record(deps, run, {
    kind: "test_design",
    actor: "ai",
    title: "test senaryoları",
    detail: `${scenarios} senaryo`,
    key: `test-design:${attempt}`,
  });
  return { scenarios };
}

/**
 * Step 10. The verdict comes from the EXIT CODES, never from the model: the
 * model is asked only to count what it sees, and a summariser that says
 * "passed" over a red build must not be able to open the PR.
 */
export async function runTests(
  deps: ActivityDeps,
  ticket: TicketKey,
  attempt = 1,
): Promise<TestRunResult> {
  const run = await deps.runs.get(ticket);
  const outcome = await deps.execution.runTurn({
    context: await turnContext(deps, run, deps.translate(run.locale, "agent.test_task", { ticket })),
    dataClass: run.dataClass,
    variantId: engineerVariantOf(run),
    ...(run.resumeToken === null ? {} : { resumeToken: run.resumeToken }),
    verification: run.verification,
  });
  const finished = await finishTurn(deps, run, outcome, "test-run");
  if (!("report" in finished)) return { passed: false, total: 0, failed: 0, coveragePct: 0 };

  const { report } = finished;
  const red = report.commands.filter((c) => c.exitCode !== 0);
  const digest = await guardModelCall(deps, run, "test-digest", () =>
    deps.llm.generateObject(
      {
        role: "test_engineer",
        variantId: engineerVariantOf(run),
        dataClass: run.dataClass,
        schemaName: "test-run",
        input: { output: report.commands.map((c) => `${c.name}: ${c.stdoutTail}`).join("\n") },
      },
      TestRunDigest,
    ),
  );
  const resolved = await resolveOutcome(deps, run, "test-digest", digest);
  const counted =
    resolved.status === "degraded"
      ? { total: report.commands.length, failed: red.length, coveragePct: 0 }
      : resolved.value;

  const passed = red.length === 0 && finished.handoverReason === undefined;
  await audit(deps, run, {
    action: "TEST_RUN_COMPLETE",
    meta: { passed, failedCommands: red.length },
    key: `tests:${attempt}:${report.at}`,
  });
  await record(deps, run, {
    kind: "test_run",
    title: passed ? "testler yeşil" : "testler kırmızı",
    detail: `${counted.failed}/${counted.total} · kapsam %${counted.coveragePct}`,
    key: `tests:${attempt}:${report.at}`,
  });
  return { passed, total: counted.total, failed: counted.failed, coveragePct: counted.coveragePct };
}
