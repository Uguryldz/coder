import { createHash } from "node:crypto";
import {
  type AnalysisDoc,
  type CiResultSignal,
  EvidencePackage,
  type EvidenceFile,
  PublishTarget,
  type TicketKey,
} from "@maestro/contracts";
import { renderEvidenceSummaryMarkdown } from "@maestro/publish";
import { evidenceKey } from "@maestro/storage";
import { ApplicationFailure } from "@temporalio/common";
import { z } from "zod";
import type { PrRef } from "../activities.js";
import type { ActivityDeps, RunContext } from "./deps.js";
import { audit, record } from "./record.js";

/** Steps 10b to 13: the pull request, the CI gate, the evidence and the close. */

export async function openPullRequest(deps: ActivityDeps, ticket: TicketKey): Promise<PrRef> {
  const run = await deps.runs.get(ticket);
  const repo = await deps.scm.resolveRepo(run.app);
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
  const ok =
    signal.ticketKey === ticket &&
    signal.adoProject === run.app.adoProject &&
    signal.adoRepo === run.app.adoRepo &&
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

export async function mergePullRequest(
  deps: ActivityDeps,
  ticket: TicketKey,
  pr: PrRef,
): Promise<{ mergeSha: string }> {
  const run = await deps.runs.get(ticket);
  const repo = { project: pr.adoProject, repo: pr.adoRepo };
  const status = await deps.scm.getPrStatus(repo, pr.prId);
  // M106: only a COMPLETED pull request has a merge commit. The active PR's
  // preview merge is not one, and receipting it would put a sha in the
  // evidence package that no branch ever pointed at.
  if (status.state !== "completed" || status.mergeSha === null) {
    throw ApplicationFailure.create({
      message: `PR #${pr.prId} is ${status.state}; no merge commit to record`,
      type: "PrNotCompleted",
      nonRetryable: false,
    });
  }
  await audit(deps, run, { action: "PR_MERGED", meta: { prId: pr.prId, mergeSha: status.mergeSha }, key: "merge" });
  await record(deps, run, { kind: "pr", title: "PR birleştirildi", detail: status.mergeSha, key: "merge" });
  return { mergeSha: status.mergeSha };
}

function evidenceFile(name: string, body: string, contentType: string): { file: EvidenceFile; bytes: Uint8Array } {
  const bytes = new TextEncoder().encode(body);
  return {
    file: {
      name,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.byteLength,
      contentType,
    },
    bytes,
  };
}

/**
 * Step 13 (M34). The package is only worth keeping if the trail behind it
 * holds, so the audit chain is verified FIRST and a broken chain refuses the
 * package outright — an archive built on an altered trail is worse than none,
 * because it looks like evidence.
 */
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
 * The `analiz` flow's last step: the document is written, published and
 * approved, and the ticket must leave Maestro's lap. The pilot learned this on
 * a real ticket (OPS-15) — a run that keeps a ticket assigned to the bot after
 * its work is done looks, to the requester, exactly like a run that is still
 * thinking, and they wait for something that is already finished.
 *
 * FAIL-SOFT, deliberately. The analysis is already in Jira and already
 * approved; failing the activity here would burn three retries and then kill a
 * run whose actual deliverable is complete. An assignment that could not be
 * made is written to the journal instead, where an operator can see it and
 * reassign by hand.
 */
export async function deliverAnalysis(
  deps: ActivityDeps,
  ticket: TicketKey,
  // Part of the activity signature (`activities.ts`), and deliberately unread
  // here: the comment is rendered from the catalog and the run's own tier, not
  // from the document. Underscored rather than removed so the shape stays.
  _analysis: AnalysisDoc | null,
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
