import { z } from "zod";
import {
  AnalysisDoc,
  EvidencePackage,
  GitSha,
  Locale,
  NonEmpty,
  RunId,
  TicketKey,
  type GateDecision,
  type ImpactCell,
} from "@maestro/contracts";
import { PublishRenderError } from "./errors.js";
import {
  DECISION_KEY_PREFIX,
  DOC_TITLE_KEY,
  IMPACT_SOURCE_KEY_PREFIX,
  MSG,
  RISK_TIER_KEY_PREFIX,
  VERDICT_KEY_PREFIX,
} from "./keys.js";
import { documentHeader, label } from "./md.js";
import type { Translate } from "./types.js";

/**
 * Release note draft (M91): produced from the ticket + merged diff by a cheap
 * model after merge. Publishing is a human decision, so the document says so.
 * Not in `packages/contracts` — see RAPOR.md interface request.
 */
export const ReleaseNoteDraft = z
  .object({
    templateVersion: NonEmpty,
    language: Locale,
    ticketKey: TicketKey,
    summary: NonEmpty,
    changes: z.array(NonEmpty).min(1),
    docUpdates: z.array(NonEmpty).default([]),
    mergeSha: GitSha,
    prId: z.number().int().positive().optional(),
  })
  .strict();
export type ReleaseNoteDraft = z.infer<typeof ReleaseNoteDraft>;

export interface DocContext {
  translate: Translate;
  /** Output language (M59/M104) — a project parameter, never a code default. */
  locale: Locale;
  runId: RunId;
  ticketKey: TicketKey;
  /**
   * Section headings from the institution's published analysis template
   * (Studio), keyed by the document field. Absent → the catalogue's fixed
   * headings. Numbering is the renderer's: the template names, the document
   * counts.
   */
  sectionTitles?: Partial<Record<AnalysisSectionField, string>>;
}

export type AnalysisSectionField =
  | "purpose"
  | "scope"
  | "impactMatrix"
  | "acceptanceCriteria"
  | "uiApiChanges"
  | "testApproach"
  | "riskAndRollback";

/**
 * Analysis document (M43): the seven mandatory sections, in order, rendered
 * from the schema-validated document. Validation runs here too — a renderer
 * that accepts a six-section analysis is a fail-open path to a human gate.
 */
export function renderAnalysisMarkdown(input: AnalysisDoc, ctx: DocContext): string {
  const doc = AnalysisDoc.parse(input);
  assertLanguage(doc.language, ctx.locale);
  const { translate: tr, locale } = ctx;
  const md = documentHeader({
    translate: tr,
    locale,
    kind: "analysis",
    titleKey: DOC_TITLE_KEY.analysis,
    runId: ctx.runId,
    ticketKey: ctx.ticketKey,
    templateVersion: doc.templateVersion,
  });

  md.heading(2, heading(ctx, "purpose", 1, MSG.sectionPurpose));
  md.paragraph(doc.purpose);

  md.heading(2, heading(ctx, "scope", 2, MSG.sectionScope));
  md.heading(3, label(tr, locale, MSG.labelScopeIncluded));
  md.bullets(doc.scope.included);
  md.heading(3, label(tr, locale, MSG.labelScopeExcluded));
  md.bullets(doc.scope.excluded, label(tr, locale, MSG.labelNone));

  md.heading(2, heading(ctx, "impactMatrix", 3, MSG.sectionImpact));
  // An analysis-only run may honestly have no repo-backed impact to list;
  // the section then says "none" rather than vanishing, so a reader knows
  // the question was asked.
  md.bullets(doc.impactMatrix.map((cell) => impactLine(cell, ctx)), label(tr, locale, MSG.labelNone));

  md.heading(2, heading(ctx, "acceptanceCriteria", 4, MSG.sectionAcceptance));
  md.bullets(doc.acceptanceCriteria);

  // `prose`, not `paragraph`: these two are the free-text sections the model
  // writes at length, and it writes them in markdown. Escaping that markdown
  // published the asterisks and ran the bullets together (see `Markdown.prose`).
  md.heading(2, heading(ctx, "uiApiChanges", 5, MSG.sectionUiApi));
  md.prose(doc.uiApiChanges);

  md.heading(2, heading(ctx, "testApproach", 6, MSG.sectionTestApproach));
  md.prose(doc.testApproach);

  /**
   * Risk reads as a STATEMENT, not as a record dump.
   *
   * Five `- **Label:** value` bullets in a row — "Risk katmanı: Orta", "Risk
   * gerekçesi: …" — is the shape of a debug print, and it is the section a
   * committee actually stops on. So the tier and its justification become the
   * sentence they always were, and only the three genuinely parallel facts
   * (risk, mitigation, rollback) stay a labelled list, because a reviewer does
   * compare those three against each other.
   */
  md.heading(2, heading(ctx, "riskAndRollback", 7, MSG.sectionRisk));
  md.paragraph(
    `${label(tr, locale, MSG.labelRiskTier)}: ${label(tr, locale, `${RISK_TIER_KEY_PREFIX}${doc.riskTier}`)} — ${doc.riskReason}`,
  );
  md.field(label(tr, locale, MSG.labelRisk), doc.riskAndRollback.risk);
  md.field(label(tr, locale, MSG.labelMitigation), doc.riskAndRollback.mitigation);
  md.field(label(tr, locale, MSG.labelRollback), doc.riskAndRollback.rollback);

  /**
   * Sections 8-15 — the analysis-agent brief. Each one appears ONLY when the
   * document carries it: an analysis written before this contract, or an
   * analysis-only run with nothing code-bound to say, keeps the seven-section
   * shape it always had. An empty "Kod karşılığı: yok" heading would tell a
   * committee the question was asked and answered, when it was never asked.
   */
  const none = label(tr, locale, MSG.labelNone);
  const verdict = (value: string): string => label(tr, locale, `${VERDICT_KEY_PREFIX}${value}`);
  let n = 8;
  if (doc.requirements.length > 0) {
    md.heading(2, `${String(n++)}. ${label(tr, locale, MSG.sectionRequirements)}`);
    md.bullets(doc.requirements.map((item, index) => `G${String(index + 1)}. ${item}`));
  }
  if (doc.businessRules.length > 0) {
    md.heading(2, `${String(n++)}. ${label(tr, locale, MSG.sectionBusinessRules)}`);
    md.bullets(doc.businessRules.map((item, index) => `K${String(index + 1)}. ${item}`));
  }
  /**
   * KEŞİF KÜNYESİ — "Kod karşılığı"nın ÖNÜNDE, çünkü onun güvenilirliğini bu
   * belirler.
   *
   * `packages/publish/src/documents.ts:150` gibi bir satır, hangi deponun
   * hangi dalında, kaç dosya okunarak bulunduğu söylenmezse doğrulanamaz bir
   * iddiadır — canlıda keşif hiç çalışmazken de belge üretildi ve okuyan kişi
   * farkı anlayamadı. Künye bu farkı ilk bakışta görünür kılar; `read: false`
   * halinde bölüm, altındaki analizin YALNIZ ticket metninden üretildiğini
   * söyler.
   *
   * Künye yoksa (`null`) bölüm hiç çizilmez — diğer koşullu bölümlerin deseni:
   * sorulmamış bir soruya "yok" cevabı yazmayız.
   */
  if (doc.discovery !== null) {
    const found = doc.discovery;
    md.heading(2, `${String(n++)}. ${label(tr, locale, MSG.sectionDiscovery)}`);
    const branch =
      found.branch === ""
        ? label(tr, locale, MSG.labelDiscoveryDefaultBranch)
        : `\`${found.branch}\``;
    md.paragraph(
      `${label(tr, locale, MSG.labelDiscoveryRepo)}: \`${found.repo}\` · ${label(tr, locale, MSG.labelDiscoveryBranch)}: ${branch}`,
    );
    if (found.read) {
      md.paragraph(
        label(tr, locale, MSG.noteDiscoveryRead, {
          files: String(found.files),
          modules: String(found.modules.length),
        }),
      );
      if (found.modules.length > 0) md.bullets(found.modules.map((module) => `\`${module}\``));
      // A read that could not be counted still says WHY the numbers are zero.
      if (found.note !== "") md.paragraph(found.note);
    } else {
      // The one line a committee must not miss: the analysis below has no code
      // behind it, and here is what to fix.
      md.paragraph(label(tr, locale, MSG.noteDiscoveryUnread, { reason: found.note }));
    }
  }
  if (doc.codeMapping.length > 0) {
    md.heading(2, `${String(n++)}. ${label(tr, locale, MSG.sectionCodeMapping)}`);
    md.bullets(
      doc.codeMapping.map(
        (row) =>
          `${row.requirement} → \`${row.location}\` — ${verdict(row.status)}${row.note === "" ? "" : `: ${row.note}`}`,
      ),
    );
  }
  if (doc.gaps.length > 0) {
    md.heading(2, `${String(n++)}. ${label(tr, locale, MSG.sectionGaps)}`);
    md.bullets(doc.gaps);
  }
  if (doc.scaleRisks.length > 0) {
    md.heading(2, `${String(n++)}. ${label(tr, locale, MSG.sectionScaleRisks)}`);
    for (const risk of doc.scaleRisks) {
      md.paragraph(`**${risk.claim}** — ${verdict(risk.verdict)}: ${risk.reason}`);
      if (risk.evidence !== "") md.field(label(tr, locale, MSG.labelEvidence), risk.evidence);
    }
  }
  if (doc.scopeOptions.length > 0) {
    md.heading(2, `${String(n++)}. ${label(tr, locale, MSG.sectionScopeOptions)}`);
    for (const decision of doc.scopeOptions) {
      md.heading(3, decision.decision);
      md.bullets(decision.options.map((option) => `${option.option} — ${option.tradeoff}`));
    }
  }
  if (doc.openQuestions.length > 0) {
    md.heading(2, `${String(n++)}. ${label(tr, locale, MSG.sectionOpenQuestions)}`);
    md.bullets(doc.openQuestions.map((item, index) => `S${String(index + 1)}. ${item}`));
  }
  if (doc.plan !== null) {
    md.heading(2, `${String(n++)}. ${label(tr, locale, MSG.sectionPlan)}`);
    md.heading(3, label(tr, locale, MSG.labelPlanFiles));
    md.bullets(doc.plan.files.map((file) => `\`${file.path}\` — ${file.change}`), none);
    md.heading(3, label(tr, locale, MSG.labelPlanEndpoints));
    md.bullets(doc.plan.endpoints.map((e) => `${e.method} \`${e.path}\` — ${e.contract}`), none);
    md.heading(3, label(tr, locale, MSG.labelPlanDtos));
    md.bullets(doc.plan.dtos.map((dto) => `${dto.name}: ${dto.fields.join(", ")}`), none);
    md.heading(3, label(tr, locale, MSG.labelPlanConventions));
    md.bullets([...doc.plan.conventions], none);
    if (doc.plan.notes !== "") md.prose(doc.plan.notes);
  }

  md.heading(2, label(tr, locale, MSG.sectionClarifications));
  md.bullets(doc.clarificationsUsed, label(tr, locale, MSG.labelNone));

  return md.toString();
}

/**
 * A section heading: the template's title when the institution named one,
 * numbered the way the catalogue's own headings are ("3. Etki analizi"), so
 * the corporate Word template's numbered slots read the same either way.
 */
function heading(ctx: DocContext, field: AnalysisSectionField, number: number, key: string): string {
  const custom = ctx.sectionTitles?.[field]?.trim();
  if (custom === undefined || custom === "") return label(ctx.translate, ctx.locale, key);
  return `${String(number)}. ${custom.replace(/^\d+[.)]\s*/, "")}`;
}

function impactLine(cell: ImpactCell, ctx: DocContext): string {
  const state = label(ctx.translate, ctx.locale, cell.impacted ? MSG.labelImpacted : MSG.labelNotImpacted);
  const source = label(ctx.translate, ctx.locale, `${IMPACT_SOURCE_KEY_PREFIX}${cell.source}`);
  return `${cell.appId} — ${state} (${source}): ${cell.summary}`;
}

/** Evidence package summary (M56/M57): what an auditor gets without the archive. */
export function renderEvidenceSummaryMarkdown(input: EvidencePackage, ctx: DocContext): string {
  const pkg = EvidencePackage.parse(input);
  if (pkg.runId !== ctx.runId || pkg.ticketKey !== ctx.ticketKey) {
    throw new PublishRenderError(
      `evidence package belongs to ${pkg.ticketKey}/${pkg.runId}, not ${ctx.ticketKey}/${ctx.runId}`,
    );
  }
  const { translate: tr, locale } = ctx;
  const md = documentHeader({
    translate: tr,
    locale,
    kind: "evidence_summary",
    titleKey: DOC_TITLE_KEY.evidence_summary,
    runId: ctx.runId,
    ticketKey: ctx.ticketKey,
    templateVersion: pkg.templateVersion,
  });
  md.field(label(tr, locale, MSG.labelEvidenceCreatedAt), pkg.createdAt);

  md.heading(2, label(tr, locale, MSG.sectionEvidenceFiles));
  md.bullets(pkg.files.map((f) => `${f.name} — ${String(f.bytes)} B · ${f.contentType} · sha256:${f.sha256}`));

  md.heading(2, label(tr, locale, MSG.sectionEvidenceApprovals));
  md.bullets(
    pkg.approvals.map((a) => approvalLine(a, ctx)),
    label(tr, locale, MSG.labelNone),
  );

  md.heading(2, label(tr, locale, MSG.sectionEvidenceRetention));
  md.field(label(tr, locale, MSG.labelRetentionYears), String(pkg.retentionYears));
  md.field(
    label(tr, locale, MSG.labelObjectLock),
    label(tr, locale, pkg.objectLock ? MSG.labelYes : MSG.labelNo),
  );

  return md.toString();
}

function approvalLine(decision: GateDecision, ctx: DocContext): string {
  const { translate: tr, locale } = ctx;
  const gate = label(tr, locale, `steps.${decision.step}`);
  const verdict = label(tr, locale, `${DECISION_KEY_PREFIX}${decision.decision}`);
  const signature = `${label(tr, locale, MSG.labelApproval)} #${String(decision.signatureSeq)}`;
  const reason = decision.reason ? ` — ${decision.reason}` : "";
  return `${gate} — ${verdict} · ${decision.actorUserId} · ${signature} · ${decision.at}${reason}`;
}

/** Post-merge release note DRAFT (M91) — publishing stays a human decision. */
export function renderReleaseNoteMarkdown(input: ReleaseNoteDraft, ctx: DocContext): string {
  const draft = ReleaseNoteDraft.parse(input);
  assertLanguage(draft.language, ctx.locale);
  if (draft.ticketKey !== ctx.ticketKey) {
    throw new PublishRenderError(`release note belongs to ${draft.ticketKey}, not ${ctx.ticketKey}`);
  }
  const { translate: tr, locale } = ctx;
  const md = documentHeader({
    translate: tr,
    locale,
    kind: "release_note",
    titleKey: DOC_TITLE_KEY.release_note,
    runId: ctx.runId,
    ticketKey: ctx.ticketKey,
    templateVersion: draft.templateVersion,
  });
  md.field(label(tr, locale, MSG.labelMergeSha), draft.mergeSha);
  if (draft.prId !== undefined) md.field(label(tr, locale, MSG.labelPullRequest), `#${String(draft.prId)}`);

  md.heading(2, label(tr, locale, MSG.sectionReleaseSummary));
  md.paragraph(draft.summary);

  md.heading(2, label(tr, locale, MSG.sectionReleaseChanges));
  md.bullets(draft.changes);

  md.heading(2, label(tr, locale, MSG.sectionReleaseDocUpdates));
  md.bullets(draft.docUpdates, label(tr, locale, MSG.labelNone));

  md.paragraph(label(tr, locale, MSG.noteReleaseDraft));
  return md.toString();
}

/**
 * The document's own language and the requested output language must agree:
 * rendering a Turkish body under English headings is exactly the kind of
 * silent mismatch M59/M104 exist to prevent.
 */
function assertLanguage(documentLanguage: Locale, requested: Locale): void {
  if (documentLanguage !== requested) {
    throw new PublishRenderError(
      `document language "${documentLanguage}" does not match the requested output language "${requested}"`,
    );
  }
}
