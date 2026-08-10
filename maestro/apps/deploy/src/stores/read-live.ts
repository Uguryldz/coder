import { AuditStoreReader, type ReadModels } from "@maestro/bff";
import type { AuditStore } from "@maestro/audit";
import { PrismaAppRegistry, PrismaGateBoard, PrismaJournalReader } from "./read-journal.js";
import {
  PrismaCostReader,
  PrismaEvidenceReader,
  PrismaKnowledgeIndex,
  PrismaQuotaReader,
} from "./read-catalog.js";
import { ProbeHealthReader, type ServiceProbe } from "./read-health.js";
import {
  PrismaOnboardingReader,
  PrismaRepoPolicyReader,
  runSampleDelegate,
} from "./read-onboarding.js";
import { PrismaRunCatalog } from "./read-runs.js";
import { unbridgedReadModel, UNBACKED_READ_MODELS } from "./read-models.js";

/**
 * Studio's read side, bridged (M7).
 *
 * Ten of the twelve read models now answer from Postgres. The other two do not
 * exist as data anywhere in this platform, and they keep refusing by name —
 * which is the whole discipline of this file and worth stating plainly:
 *
 *  · `runners` (M60) — there is no runner-fleet table and `RunnerPort` exposes
 *    no fleet-wide inventory; a runner reports itself to nothing. A table
 *    would be a table nothing writes.
 *  · `scans` (M27) — scan results are produced inside the workflow
 *    (`packages/workflows/src/impl/scan.ts`) and consumed by the gate that
 *    blocks on them; nothing persists one. Same again.
 *
 * Adding migration 0005 for either would create columns no producer ever
 * fills, so every read would return an empty page — and an empty page is
 * exactly the failure `stores/read-models.ts` was written to prevent: it
 * renders as "no runners in the fleet" and "no findings", which an operator
 * reads as a healthy platform. The honest report is that the capability is not
 * wired, so these two stay refusing and are named in `DEGRADED_CAPABILITIES`.
 * They become real when something WRITES them, not before.
 */

/** Everything `liveReadModels` needs from the Prisma client. */
export interface ReadModelDb {
  workflowRun: ConstructorParameters<typeof PrismaRunCatalog>[0] &
    Parameters<typeof runSampleDelegate>[0];
  llmCall: ConstructorParameters<typeof PrismaRunCatalog>[1] &
    ConstructorParameters<typeof PrismaCostReader>[0];
  journalEntry: ConstructorParameters<typeof PrismaJournalReader>[0];
  gate: ConstructorParameters<typeof PrismaGateBoard>[0];
  application: ConstructorParameters<typeof PrismaAppRegistry>[0] &
    ConstructorParameters<typeof PrismaOnboardingReader>[1];
  jiraProjectBinding: ConstructorParameters<typeof PrismaOnboardingReader>[0];
  repoCard: ConstructorParameters<typeof PrismaAppRegistry>[1];
  knowledgeDoc: ConstructorParameters<typeof PrismaKnowledgeIndex>[0];
  subscriptionAccount: ConstructorParameters<typeof PrismaQuotaReader>[0];
  evidencePackageRow: ConstructorParameters<typeof PrismaEvidenceReader>[0];
}

export interface LiveReadModelOptions {
  db: ReadModelDb;
  /**
   * The audit chain's store — the SAME one the BFF appends through.
   *
   * Shared rather than a second reader over the same table, because a reader
   * with its own store would verify itself: `verify()` has to recompute the
   * chain a writer actually wrote, or it proves nothing (M33).
   */
  audit: AuditStore;
  /** What `/studio/health` probes (M6). */
  probes: readonly ServiceProbe[];
}

/**
 * The twelve, ten of them live.
 *
 * Every key of `ReadModels` appears and the compiler enforces that, so a
 * thirteenth read model breaks this file at build time — the correct place to
 * find out.
 */
export function liveReadModels(options: LiveReadModelOptions): ReadModels {
  const { db } = options;
  return {
    runs: new PrismaRunCatalog(db.workflowRun, db.llmCall),
    journal: new PrismaJournalReader(db.journalEntry),
    gates: new PrismaGateBoard(db.gate),
    apps: new PrismaAppRegistry(db.application, db.repoCard),
    knowledge: new PrismaKnowledgeIndex(db.knowledgeDoc),
    runners: {
      list: unbridgedReadModel("runners", "list"),
      sandboxes: unbridgedReadModel("runners", "sandboxes"),
    },
    quota: new PrismaQuotaReader(db.subscriptionAccount),
    cost: new PrismaCostReader(db.llmCall),
    scans: { list: unbridgedReadModel("scans", "list") },
    evidence: new PrismaEvidenceReader(db.evidencePackageRow),
    audit: new AuditStoreReader(options.audit),
    health: new ProbeHealthReader(options.probes),
    // Both read tables the platform already writes (M93/M102/M52): the binding
    // rows, the application registry, and the runs whose `matchJson` the dry
    // run replays. Neither invents a row, so neither needs to refuse.
    onboarding: new PrismaOnboardingReader(
      db.jiraProjectBinding,
      db.application,
      runSampleDelegate(db.workflowRun),
    ),
    repoPolicy: new PrismaRepoPolicyReader(db.application, runSampleDelegate(db.workflowRun)),
  };
}

/** The read models still refusing, for the boot banner and RAPOR.md. */
export const DEGRADED_READ_MODELS: readonly string[] = UNBACKED_READ_MODELS;
