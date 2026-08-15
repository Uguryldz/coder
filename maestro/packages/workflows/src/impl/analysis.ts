import {
  AnalysisDoc,
  NonEmpty,
  PublishTarget,
  type RiskTier,
  type TicketKey,
} from "@maestro/contracts";
import { renderAnalysisMarkdown } from "@maestro/publish";
import { ApplicationFailure } from "@temporalio/common";
import { z } from "zod";
import type { ActivityDeps, RunContext } from "./deps.js";
import { resolveOutcome } from "./outcome.js";
import { activitySeq, audit, record } from "./record.js";

/**
 * Steps 3ö and 3: read-only repo discovery and the analysis document.
 *
 * The analysis is the one artefact a human gate judges, so everything here is
 * fail-closed: a document that misses a section, names the wrong template
 * version (M83) or is written in the wrong language never reaches step 4.
 */

export const DiscoveryDigest = z.object({
  files: z.number().int().nonnegative(),
  modules: z.array(NonEmpty).max(200),
});

/** M18/M97: the analysis cannot be written by a human inside this activity. */
export const AI_ASSIST_REQUIRED = "AiAssistRequired";

function aiAssistRequired(what: string, messageKey: string): ApplicationFailure {
  return ApplicationFailure.create({
    message: `${what} needs a human in ai-assist mode: ${messageKey}`,
    type: AI_ASSIST_REQUIRED,
    nonRetryable: true,
  });
}

/**
 * Step 3ö — a read-only session in the PRIMARY application's repo (M100). The
 * session's resume token is kept: step 6a continues the same conversation
 * rather than re-reading the repository (M30).
 */
export async function discoverRepo(
  deps: ActivityDeps,
  ticket: TicketKey,
  appId: string,
): Promise<{ files: number; modules: string[] }> {
  const run = await deps.runs.get(ticket);
  const session = await deps.llm.agentSession({
    workspacePath: run.workspacePath,
    task: deps.translate(run.locale, "agent.discovery_task", { ticket, appId }),
    /**
     * No MCP server for the discovery pass.
     *
     * Reading a checkout is what the agent's own file tools already do, and
     * `@maestro/mcp-servers`' workspace server has no runnable entry point —
     * asking for it made every deployment fail with "mcpServers were requested
     * but no --mcp-config path was given", which reads as a configuration
     * mistake rather than as a server nobody starts.
     *
     * The engineering turn is where an MCP surface earns its keep: it needs
     * tools the CLI does not ship (the platform's own read model, the ticket).
     * This step needs a directory, and it has one.
     */
    mcpServers: [],
    dataClass: run.dataClass,
    variantId: run.variantId,
  });
  const explored = await resolveOutcome(deps, run, "discovery", session);
  if (explored.status === "degraded") return { files: 0, modules: [] };

  await deps.runs.patch(ticket, { resumeToken: explored.value.resumeToken });
  const digest = await deps.llm.generateObject(
    {
      role: "analyst",
      variantId: run.variantId,
      dataClass: run.dataClass,
      schemaName: "repo-discovery",
      input: { appId, findings: explored.value.finalText },
    },
    DiscoveryDigest,
  );
  const resolved = await resolveOutcome(deps, run, "discovery-digest", digest);
  const value = resolved.status === "degraded" ? { files: 0, modules: [] } : resolved.value;
  await record(deps, run, {
    kind: "discovery",
    actor: "ai",
    title: "repo keşfi",
    detail: `${value.files} dosya · ${value.modules.length} modül`,
    key: "discovery",
  });
  return { files: value.files, modules: [...value.modules] };
}

/** M83/M59: the pinned template and the project's language are not negotiable. */
function assertDocument(run: RunContext, doc: AnalysisDoc): void {
  if (doc.templateVersion !== run.templateVersion) {
    throw ApplicationFailure.create({
      message: `analysis used template ${doc.templateVersion}, the run is pinned to ${run.templateVersion}`,
      type: "AnalysisTemplateMismatch",
      nonRetryable: true,
    });
  }
  if (doc.language !== run.locale) {
    throw ApplicationFailure.create({
      message: `analysis is in "${doc.language}", the project's language is "${run.locale}"`,
      type: "AnalysisLanguageMismatch",
      nonRetryable: true,
    });
  }
}

/**
 * Step 3. The risk tier is the DOCUMENT's, never a parameter and never a
 * default: it is the reason the analysis is read before the gates are chosen
 * (M51). `AnalysisDoc` is `.strict()` with seven required sections, so a
 * partial answer fails here instead of at a human's desk.
 */
export async function writeAnalysis(
  deps: ActivityDeps,
  ticket: TicketKey,
  appId: string,
): Promise<{ analysis: AnalysisDoc; risk: RiskTier }> {
  const run = await deps.runs.get(ticket);
  const snapshot = await deps.work.getTicket(ticket);
  const outcome = await deps.llm.generateObject(
    {
      role: "analyst",
      variantId: run.variantId,
      dataClass: run.dataClass,
      schemaName: "analysis-doc",
      input: {
        appId,
        locale: run.locale,
        templateVersion: run.templateVersion,
        summary: snapshot.summary,
        description: snapshot.description,
      },
    },
    AnalysisDoc,
  );
  const resolved = await resolveOutcome(deps, run, "analysis", outcome);
  if (resolved.status === "degraded") throw aiAssistRequired("analysis", resolved.messageKey);

  const analysis = AnalysisDoc.parse(resolved.value);
  assertDocument(run, analysis);
  await deps.runs.patch(ticket, { risk: analysis.riskTier });
  await record(deps, run, {
    kind: "analysis",
    actor: "ai",
    title: "analiz yazıldı",
    detail: `risk: ${analysis.riskTier} — ${analysis.riskReason}`,
    // A rewrite after a rejection can legitimately land on the same tier and
    // the same criteria count; keying on the document's shape would hide the
    // second version behind the first.
    key: `analysis:${activitySeq()}`,
  });
  return { analysis, risk: analysis.riskTier };
}

/** Step 3, publication (M47): the same document on every configured target. */
export async function publishAnalysis(
  deps: ActivityDeps,
  ticket: TicketKey,
  analysis: AnalysisDoc,
): Promise<void> {
  const run = await deps.runs.get(ticket);
  const targets = z
    .array(PublishTarget)
    .min(1)
    .parse(await deps.params.publishTargets(run.runId, "analysis"));
  const markdown = renderAnalysisMarkdown(analysis, {
    translate: deps.translate,
    locale: run.locale,
    runId: run.runId,
    ticketKey: ticket,
  });
  // Idempotent by construction on the driver side (M75 bookkeeping), and by
  // the guard here: a retry must not post the analysis to Jira twice.
  const receipts = await deps.idempotency.once(`${run.runId}:publish:analysis`, () =>
    deps.publish.publish({ runId: run.runId, doc: "analysis", targets, locale: run.locale }, markdown),
  );
  await record(deps, run, {
    kind: "analysis",
    title: "analiz yayımlandı",
    detail: receipts.map((r) => `${r.target}:${r.ref}`).join(", "),
    key: "publish-analysis",
  });
}

/**
 * M100 fan-out: every OTHER application the impact matrix marks as impacted
 * gets a child ticket in the parent's project. The assignment comes from the
 * analysis, not from a rule lookup — the matrix is the decision.
 */
export async function fanOutChildren(
  deps: ActivityDeps,
  ticket: TicketKey,
  analysis: AnalysisDoc,
): Promise<TicketKey[]> {
  const run = await deps.runs.get(ticket);
  const impacted = analysis.impactMatrix
    .filter((cell) => cell.impacted && cell.appId !== run.app.appId)
    .sort((a, b) => a.appId.localeCompare(b.appId));

  const children: TicketKey[] = [];
  for (const cell of impacted) {
    const created = await deps.idempotency.once(`${run.runId}:fanout:${cell.appId}`, () =>
      deps.work.createLinkedIssue(ticket, {
        summary: deps.translate(run.locale, "jira.child_summary", { ticket, app: cell.appId }),
        description: cell.summary,
        labels: ["maestro", `app:${cell.appId}`],
      }),
    );
    children.push(created.key);
    await audit(deps, run, {
      action: "ASSIGN_APP",
      subject: created.key,
      meta: { via: "analysis_fanout", appId: cell.appId, parentTicketKey: ticket },
      key: `fanout:${cell.appId}`,
    });
  }
  return children;
}
