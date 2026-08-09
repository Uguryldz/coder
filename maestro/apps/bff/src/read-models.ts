import type {
  AppId,
  ApplicationRecord,
  AuditEvent,
  DataClass,
  EvidencePackage,
  JournalEntry,
  LlmCallLog,
  PlatformProfile,
  RepoCard,
  RiskTier,
  ScanFinding,
  StepId,
  SubscriptionAccount,
  TicketKey,
  WorkMode,
} from "@maestro/contracts";

/**
 * The read side of the single data door (M7). Studio renders 37 screens, and
 * every field on them has to come from somewhere real — so each resource below
 * is an interface the composition root fills, never a literal a route invents.
 *
 * These live in the BFF because they are the BFF's shape of the world, not the
 * platform's: `packages/contracts` and `packages/ports` are frozen, and a read
 * model that exists to serve one UI has no business in either. Everything here
 * is expressed in frozen contract types wherever a contract type exists — the
 * BFF adds the joins Studio needs, not new vocabulary for facts that already
 * have names.
 *
 * Every list method takes a bounded page and returns a cursor. An unbounded
 * list endpoint is a denial-of-service handle in a system whose journal grows
 * without limit (M30), and "the UI only asked for 50" is not a bound.
 */

/** One page of a list, with the cursor that continues it. `null` = no more. */
export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export interface PageRequest {
  readonly limit: number;
  readonly cursor: string | null;
}

// ── runs (M99/M100: the ticket's platform-side facts) ─────────────────────────

/**
 * What the workflow engine does NOT know about a run. `WorkflowRunState` (the
 * frozen contract) carries step/status/risk; the application it was matched to,
 * who reported it and what it has cost are platform records, and Studio's
 * ticket list shows them side by side.
 */
export interface RunRecord {
  readonly ticketKey: TicketKey;
  readonly title: string;
  readonly appId: AppId | null;
  readonly mode: WorkMode;
  readonly risk: RiskTier;
  readonly dataClass: DataClass;
  /** Parent ticket for a fan-out child (M100); `null` for a standalone run. */
  readonly parentTicketKey: TicketKey | null;
  readonly childTicketKeys: readonly TicketKey[];
  readonly reporter: string;
  readonly assignee: string | null;
  readonly prId: number | null;
  readonly costUsd: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly startedAt: string;
  readonly updatedAt: string;
}

export interface RunCatalogFilter extends PageRequest {
  readonly appId: string | null;
  readonly projectKeys: readonly string[] | null;
}

/**
 * Per-run platform metadata. Reads only: a run's facts change because the
 * workflow advanced, never because Studio asked for them.
 */
export interface RunCatalog {
  get(ticketKey: string): Promise<RunRecord | null>;
  list(filter: RunCatalogFilter): Promise<Page<RunRecord>>;
}

// ── journal (M30) ─────────────────────────────────────────────────────────────

export interface JournalFilter extends PageRequest {
  /** Studio's actor chips; `null` shows everything. */
  readonly actor: JournalEntry["actor"] | null;
}

export interface JournalReader {
  list(runId: string, filter: JournalFilter): Promise<Page<JournalEntry>>;
  /** The living summary text (M30), or `null` when the run has produced none. */
  summary(runId: string): Promise<string | null>;
}

// ── gates (M71/M101) ──────────────────────────────────────────────────────────

/**
 * A gate waiting on a human. Deliberately a READ model: `canCloseGate` lives in
 * `packages/workflows` and a decision reaches it as a signal, so there is no
 * shape here that could be mistaken for a way to close one.
 */
export interface OpenGate {
  readonly ticketKey: TicketKey;
  readonly runId: string;
  readonly step: StepId;
  readonly ownerGroup: string;
  readonly openedAt: string;
  /** Who the reminder ladder has escalated to, if it has (M45). */
  readonly delegatedTo: string | null;
}

export interface GateFilter extends PageRequest {
  readonly ownerGroup: string | null;
  readonly projectKeys: readonly string[] | null;
}

export interface GateBoard {
  listOpen(filter: GateFilter): Promise<Page<OpenGate>>;
}

// ── application registry + repo cards (M100) ──────────────────────────────────

export interface AppRegistry {
  get(appId: string): Promise<ApplicationRecord | null>;
  list(page: PageRequest): Promise<Page<ApplicationRecord>>;
  /** The analyst's cross-app impact source (M100); `null` when never generated. */
  repoCard(appId: string): Promise<RepoCard | null>;
}

// ── knowledge (M18/M63) ───────────────────────────────────────────────────────

/**
 * A knowledge document. `dataClass` is REQUIRED and never defaulted: an index
 * that cannot classify a document must report `gizli`, because an unlabelled
 * confidential file read as `dahili` is exactly how one leaves the building.
 */
export interface KnowledgeDoc {
  readonly id: string;
  readonly title: string;
  readonly snippet: string;
  readonly source: string;
  readonly score: number;
  readonly dataClass: DataClass;
  readonly appId: AppId | null;
  readonly updatedBy: string;
  readonly updatedAt: string;
}

export interface KnowledgeQuery extends PageRequest {
  readonly text: string;
  readonly appId: string | null;
}

export interface KnowledgeIndex {
  search(query: KnowledgeQuery): Promise<Page<KnowledgeDoc>>;
}

// ── runners + sandboxes (M60/M31) ─────────────────────────────────────────────

export interface RunnerRecord {
  readonly runnerId: string;
  readonly pool: string;
  readonly platform: PlatformProfile;
  readonly state: "idle" | "busy" | "draining" | "unreachable";
  readonly capacity: number;
  readonly activeSandboxes: number;
  readonly lastHeartbeatAt: string;
  /** Why a runner is not fully healthy; `null` when it is. */
  readonly note: string | null;
}

export interface SandboxRecord {
  readonly ticketKey: TicketKey;
  readonly runnerId: string;
  readonly state: "active" | "resumable" | "human_held";
  readonly sizeBytes: number;
  readonly lastAccessAt: string;
}

export interface RunnerFleet {
  list(page: PageRequest): Promise<Page<RunnerRecord>>;
  sandboxes(page: PageRequest): Promise<Page<SandboxRecord>>;
}

// ── quota + cost (M55/M16) ────────────────────────────────────────────────────

export interface QuotaReader {
  /** The subscription account pool and its windows (M55). */
  accounts(): Promise<readonly SubscriptionAccount[]>;
}

export interface CostFilter extends PageRequest {
  readonly runId: string | null;
}

export interface CostReader {
  /** Gateway call log rows (M16); the per-run and per-model breakdowns derive from these. */
  calls(filter: CostFilter): Promise<Page<LlmCallLog>>;
}

// ── security scans (M27) ──────────────────────────────────────────────────────

export interface ScanRecord {
  readonly ticketKey: TicketKey;
  readonly finding: ScanFinding;
  readonly outcome: "pass" | "fail" | "error";
  readonly at: string;
}

export interface ScanFilter extends PageRequest {
  readonly projectKeys: readonly string[] | null;
}

export interface ScanReader {
  list(filter: ScanFilter): Promise<Page<ScanRecord>>;
}

// ── evidence (M56) ────────────────────────────────────────────────────────────

export interface EvidenceReader {
  /** The manifest for a closed run (M56); `null` before the package is built. */
  get(runId: string): Promise<EvidencePackage | null>;
}

// ── audit (M33) ───────────────────────────────────────────────────────────────

export interface AuditFilter extends PageRequest {
  readonly actor: string | null;
  readonly subject: string | null;
}

/**
 * The trail as Studio reads it. `AuditChain` already owns appending and
 * verification; this is the query side, which the chain deliberately does not
 * expose — a reader that could reach `append` would be a second writer.
 */
export interface AuditReader {
  list(filter: AuditFilter): Promise<Page<AuditEvent>>;
  /** Recompute the hash chain (M33). Read-only: it proves, it never repairs. */
  verify(): Promise<{ ok: boolean; checked: number; brokenAtSeq: number | null }>;
}

// ── platform services health (M6) ─────────────────────────────────────────────

export interface ServiceHealth {
  readonly service: string;
  readonly state: "healthy" | "degraded" | "down";
  readonly version: string;
  readonly checkedAt: string;
  readonly note: string | null;
}

export interface HealthReader {
  services(): Promise<readonly ServiceHealth[]>;
}
