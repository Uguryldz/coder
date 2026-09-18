import {
  type AnalysisDoc,
  type CiResultSignal,
  EvidencePackage,
  PublishTarget,
  type TicketKey,
} from "@maestro/contracts";
import { renderEvidenceSummaryMarkdown } from "@maestro/publish";
import { evidenceKey } from "@maestro/storage";
import { ApplicationFailure } from "@temporalio/common";
import { z } from "zod";
import type { BuildPoll, MergeOutcome, PrRef, PublishResult } from "../activities.js";
import { deliverAnalysisDocs } from "./analysis-docs.js";
import type { ActivityDeps, RunContext } from "./deps.js";
import { evidenceFile } from "./evidence-file.js";
import { audit, record } from "./record.js";

/** Steps 10b to 13: the pull request, the CI gate, the evidence and the close. */

/**
 * The run's application, for the steps that cannot exist without one.
 *
 * `RunContext.app` is `null` only for an analysis-only run, and the workflow
 * hands over before the engineering half whenever there is no application —
 * so reaching this with `null` means that invariant broke somewhere upstream.
 * Failing non-retryably is the honest answer: no number of retries will bind
 * a repository to a run whose binding never named one, and inventing a blank
 * `ApplicationRecord` here would aim a pull request at repo "".
 */
function appOf(run: RunContext): NonNullable<RunContext["app"]> {
  if (run.app === null) {
    throw ApplicationFailure.create({
      message: `run ${run.runId} has no application; the engineering path must not be reachable on an analysis-only run`,
      type: "NoApplicationBound",
      nonRetryable: true,
    });
  }
  return run.app;
}

/** Maestro's feature branch for a ticket: `maestro/<ticket>`, lower-case, safe for a ref name. */
export function featureBranchFor(ticket: string): string {
  const slug = ticket.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `maestro/${slug === "" ? "run" : slug}`;
}

/**
 * Step 6a leaves its edits in the clone; nothing else ever put them on a
 * branch. This is the missing half: commit, push, remember the branch on the
 * run so `openPullRequest` names a branch that exists. A run whose turn
 * produced no change has nothing to open a PR from, and says so instead of
 * opening an empty one.
 */
export async function publishBranch(deps: ActivityDeps, ticket: TicketKey): Promise<PublishResult> {
  const run = await deps.runs.get(ticket);
  const app = appOf(run);
  const branch = run.branch.trim() === "" ? featureBranchFor(ticket) : run.branch;
  if (deps.scm.publishWorkspace === undefined) {
    await record(deps, run, {
      kind: "pr",
      title: "dal yayımlanamadı",
      detail: "bu kurulumun SCM sürücüsü çalışma alanını yayımlayamıyor (publishWorkspace yok)",
      key: "publish-unsupported",
    });
    return { pushed: false, branch, reason: "scm: publishWorkspace not supported by this deployment" };
  }
  if (!run.workspacePresent || run.workspacePath.trim() === "") {
    return { pushed: false, branch, reason: "çalışma alanı yok — geliştirme turu bir klon bırakmadı" };
  }
  const repo = await deps.scm.resolveRepo(app);
  const result = await deps.scm.publishWorkspace({
    runId: run.runId,
    appId: app.appId,
    repo,
    workspacePath: run.workspacePath,
    branch,
    message: `${ticket}: ${deps.translate(run.locale, "pr.title")}`,
  });
  if (!result.pushed) {
    await record(deps, run, {
      kind: "pr",
      title: "yayımlanacak değişiklik yok",
      detail: "geliştirme turu çalışma alanında hiçbir dosyayı değiştirmedi",
      key: `publish-empty:${deps.now().toISOString()}`,
    });
    return { pushed: false, branch, reason: "geliştirme turu hiçbir dosyayı değiştirmedi — açılacak PR yok" };
  }
  await deps.runs.patch(ticket, { branch });
  await audit(deps, run, {
    action: "BRANCH_PUSHED",
    meta: { branch, sha: result.sha, files: result.files, credential: result.credential },
    key: `push:${result.sha}`,
  });
  await record(deps, run, {
    kind: "pr",
    title: "dal yayımlandı",
    detail: `${branch} @ ${result.sha.slice(0, 10)} · ${String(result.files)} dosya · kimlik: ${
      result.credential === "short_lived" ? "kısa ömürlü jeton (M31)" : "bağlantı jetonu (Vault yok)"
    }`,
    key: `push:${result.sha}`,
  });
  return { pushed: true, branch, sha: result.sha, files: result.files };
}

/**
 * GitHub has no build webhook into Maestro; its verdict is pulled from the
 * commit's check runs. ADO keeps its signal path — a driver without
 * `getCommitChecks` answers `unsupported` and the workflow keeps waiting for
 * the webhook exactly as before.
 */
export async function pollBuild(deps: ActivityDeps, ticket: TicketKey, sha: string): Promise<BuildPoll> {
  const run = await deps.runs.get(ticket);
  if (deps.scm.getCommitChecks === undefined) return { state: "unsupported", detail: [] };
  const repo = await deps.scm.resolveRepo(appOf(run));
  const checks = await deps.scm.getCommitChecks(repo, sha);
  return { state: checks.state, detail: [...checks.detail] };
}

export async function openPullRequest(deps: ActivityDeps, ticket: TicketKey): Promise<PrRef> {
  const run = await deps.runs.get(ticket);
  const repo = await deps.scm.resolveRepo(appOf(run));
  // Draft first: the PR exists before build validation is asked for, so a
  // retry of this activity finds the run's `prId` and opens nothing new.
  const opened = await deps.idempotency.once(`${run.runId}:pr`, () =>
    deps.scm.openPr(repo, {
      sourceBranch: run.branch,
      targetBranch: run.targetBranch,
      title: `${ticket} — ${deps.translate(run.locale, "pr.title")}`,
      description: deps.translate(run.locale, "pr.description", { ticket }),
      draft: true,
    }),
  );
  await deps.runs.patch(ticket, { prId: opened.prId });
  await audit(deps, run, { action: "PR_OPENED", meta: { prId: opened.prId }, key: "pr" });
  await record(deps, run, {
    kind: "pr",
    title: `PR #${opened.prId} açıldı`,
    detail: `${repo.project}/${repo.repo}`,
    key: "pr-open",
  });
  return { adoProject: repo.project, adoRepo: repo.repo, prId: opened.prId };
}

/** Leaving draft is what triggers the branch policy's build validation (M12). */
export async function activatePullRequest(
  deps: ActivityDeps,
  ticket: TicketKey,
  pr: PrRef,
): Promise<void> {
  const run = await deps.runs.get(ticket);
  await deps.idempotency.once(`${run.runId}:pr-activate`, () =>
    deps.scm.activatePr({ project: pr.adoProject, repo: pr.adoRepo }, pr.prId),
  );
}

/**
 * M106. A build result is evidence only if it came from THIS run's repository.
 *
 * ticketKey + prId do not identify a build: a mirrored or forked repo in
 * another project carries the same branch name and the same PR id, and a green
 * build there would merge an unbuilt change here. An origin the driver could
 * not determine is `undefined`, and `undefined` is rejected — a missing claim
 * is not a matching one.
 */
export async function verifyCiOrigin(
  deps: ActivityDeps,
  ticket: TicketKey,
  signal: CiResultSignal,
): Promise<boolean> {
  const run = await deps.runs.get(ticket);
  const app = appOf(run);
  const ok =
    signal.ticketKey === ticket &&
    signal.adoProject === app.adoProject &&
    signal.adoRepo === app.adoRepo &&
    (run.prId === null || signal.prId === run.prId);

  await audit(deps, run, {
    action: "CI_RESULT",
    meta: {
      accepted: ok,
      buildId: signal.buildId,
      status: signal.status,
      origin: `${signal.adoProject ?? "?"}/${signal.adoRepo ?? "?"}`,
    },
    key: `ci:${signal.buildId}`,
  });
  return ok;
}

/**
 * Who merges depends on the work mode, and the answer is a value, not an
 * exception: `full_auto` merges the PR itself once every gate before this
 * point has passed; every other mode waits for a human on the SCM and asks
 * again later. The old shape (throw `PrNotCompleted`, let Temporal retry)
 * turned "a human has not merged yet" into three failed attempts and a
 * handover — a PR could never be merged by hand in time.
 */
export async function mergePullRequest(deps: ActivityDeps, ticket: TicketKey, pr: PrRef): Promise<MergeOutcome> {
  const run = await deps.runs.get(ticket);
  const repo = { project: pr.adoProject, repo: pr.adoRepo };
  const status = await deps.scm.getPrStatus(repo, pr.prId);
  if (status.state === "completed" && status.mergeSha !== null) {
    await recordMerge(deps, run, pr, status.mergeSha, "human");
    return { mergeSha: status.mergeSha, state: "completed", by: "human" };
  }
  if (status.state === "abandoned") {
    await record(deps, run, { kind: "pr", title: "PR terk edildi", detail: `#${String(pr.prId)}`, key: "pr-abandoned" });
    return { mergeSha: null, state: "abandoned", by: null };
  }
  const merge = deps.scm.mergePr;
  if (run.mode === "full_auto" && merge !== undefined) {
    const merged = await deps.idempotency.once(`${run.runId}:merge`, () => merge.call(deps.scm, repo, pr.prId));
    await recordMerge(deps, run, pr, merged.mergeSha, "maestro");
    return { mergeSha: merged.mergeSha, state: "completed", by: "maestro" };
  }
  return { mergeSha: null, state: status.state, by: null };
}

async function recordMerge(
  deps: ActivityDeps,
  run: RunContext,
  pr: PrRef,
  mergeSha: string,
  by: "maestro" | "human",
): Promise<void> {
  await audit(deps, run, { action: "PR_MERGED", meta: { prId: pr.prId, mergeSha, by }, key: "merge" });
  await record(deps, run, {
    kind: "pr",
    title: by === "maestro" ? "PR Maestro tarafından birleştirildi (full_auto)" : "PR birleştirildi",
    detail: mergeSha,
    key: "merge",
  });
}

export async function buildEvidencePackage(
  deps: ActivityDeps,
  ticket: TicketKey,
): Promise<{ files: number; storageKey: string }> {
  const run = await deps.runs.get(ticket);
  const verification = await deps.audit.verify();
  if (!verification.ok) {
    throw ApplicationFailure.create({
      message: `audit chain is not intact (first bad seq ${String(verification.firstBadSeq)})`,
      type: "AuditChainBroken",
      nonRetryable: true,
    });
  }

  const createdAt = deps.now().toISOString();
  const approvals = await deps.gates.decisions(run.runId);
  const entries = await deps.memory.store.list(run.runId);
  const parts = [
    evidenceFile("journal.json", JSON.stringify(entries, null, 2), "application/json"),
    evidenceFile("approvals.json", JSON.stringify(approvals, null, 2), "application/json"),
    evidenceFile(
      "audit-verification.json",
      JSON.stringify({ checked: verification.checked, headHash: verification.headHash }, null, 2),
      "application/json",
    ),
  ];

  const manifest = EvidencePackage.parse({
    runId: run.runId,
    ticketKey: ticket,
    createdAt,
    templateVersion: run.templateVersion,
    files: parts.map((p) => p.file),
    approvals,
    objectLock: true,
  });

  for (const part of parts) {
    const key = evidenceKey({ ticketKey: ticket, runId: run.runId, fileName: part.file.name, createdAt });
    await deps.storage.put(key, part.bytes, { contentType: part.file.contentType, objectLock: true });
  }
  const manifestKey = evidenceKey({
    ticketKey: ticket,
    runId: run.runId,
    fileName: "manifest.json",
    createdAt,
  });
  await deps.storage.put(manifestKey, new TextEncoder().encode(JSON.stringify(manifest, null, 2)), {
    contentType: "application/json",
    objectLock: true,
  });

  const targets = z
    .array(PublishTarget)
    .min(1)
    .parse(await deps.params.publishTargets(run.runId, "evidence_summary"));
  await deps.idempotency.once(`${run.runId}:publish:evidence`, () =>
    deps.publish.publish(
      { runId: run.runId, doc: "evidence_summary", targets, locale: run.locale },
      renderEvidenceSummaryMarkdown(manifest, {
        translate: deps.translate,
        locale: run.locale,
        runId: run.runId,
        ticketKey: ticket,
      }),
    ),
  );
  await record(deps, run, {
    kind: "closure",
    title: "kanıt paketi",
    detail: `${parts.length + 1} dosya · ${manifestKey}`,
    key: "evidence",
  });
  return { files: parts.length + 1, storageKey: manifestKey };
}

/**
 * Hand a finished ANALYSIS back to the person who asked for it.
 *
 * The `analiz` flow's last step: the document is written, published, approved
 * and rendered to a real Word/PDF on the ticket, so the ticket must leave
 * Maestro's lap. The pilot learned this on a real ticket (OPS-15) — a run that
 * keeps a ticket assigned to the bot after its work is done looks, to the
 * requester, exactly like a run still thinking, and they wait for something
 * that is already finished.
 *
 * FAIL-SOFT, deliberately. The analysis is already in Jira and already
 * approved; failing here would burn three retries and kill a run whose actual
 * deliverable is complete. An assignment that could not be made is written to
 * the journal instead, for an operator to see and reassign by hand.
 */
export async function deliverAnalysis(
  deps: ActivityDeps,
  ticket: TicketKey,
  analysis: AnalysisDoc | null,
): Promise<void> {
  const run: RunContext = await deps.runs.get(ticket);
  const requester = (await deps.work.getTicket(ticket)).reporter?.trim() ?? "";

  await deps.idempotency.once(`${run.runId}:deliver-comment`, () =>
    deps.work.addComment(
      ticket,
      deps.translate(run.locale, "jira.analysis_delivered", {
        ticket,
        // The tier lives on the RUN, not on the document.
        risk: run.risk ?? "",
      }),
    ),
  );

  // The Word/PDF the analyst actually files (M103r). Fail-soft: it never
  // throws, so a render or upload problem is reported to the journal AND the
  // ticket rather than costing the assignment below.
  await deliverAnalysisDocs(deps, run, ticket, analysis);

  if (requester === "") {
    // Not an error: a ticket may genuinely have no reporter Maestro can act on
    // (an integration account, a migrated issue). Left where it is, and said so.
    await record(deps, run, {
      kind: "closure",
      title: "analiz teslim edildi",
      detail: "talep sahibi bulunamadı — ticket atanmadan bırakıldı",
      key: "deliver:no-requester",
    });
    return;
  }

  try {
    await deps.idempotency.once(`${run.runId}:deliver-assign`, () =>
      deps.work.assign(ticket, requester),
    );
    await record(deps, run, {
      kind: "closure",
      title: "analiz teslim edildi",
      detail: `ticket talep sahibine atandı: ${requester}`,
      key: "deliver:assigned",
    });
  } catch (error) {
    await record(deps, run, {
      kind: "closure",
      title: "analiz teslim edildi",
      detail: `atama yapılamadı (analiz etkilenmedi): ${String(error)}`,
      key: "deliver:assign-failed",
    });
  }
}

export async function closeTicket(deps: ActivityDeps, ticket: TicketKey): Promise<void> {
  const run: RunContext = await deps.runs.get(ticket);
  await deps.idempotency.once(`${run.runId}:close-comment`, () =>
    deps.work.addComment(ticket, deps.translate(run.locale, "jira.closed", { ticket })),
  );
  // M102: the DC driver has no workflow permissions, so progress is a label.
  await deps.idempotency.once(`${run.runId}:close-label`, () =>
    deps.work.setLabels(ticket, ["maestro-tamamlandi"]),
  );
  await audit(deps, run, { action: "RUN_CLOSED", key: "close" });
  /**
   * The ROW must agree that the run is over.
   *
   * `RunContextStore.get` reads the newest run whose status is not terminal, so
   * a finished run that never writes this stays "live" forever: Studio lists it
   * as running, and — worse — the ticket can never start a second run, because
   * intake would keep joining this one. Temporal knew OPS-40 was `Completed`
   * while its row still said `running`.
   */
  await deps.runs.patch(ticket, { status: "done" });
  deps.execution.endRun(run.runId);
}
