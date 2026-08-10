import type { AuditChain } from "@maestro/audit";
import type { Env } from "@maestro/config";
import type {
  CommandEnvelope,
  DataClass,
  Locale,
  ParamChange,
  ParamDefinition,
  StepId,
  TicketKey,
  WorkMode,
} from "@maestro/contracts";
import type { CiPort, WorkPort } from "@maestro/ports";
import type { RunGateway } from "./gateway.js";
import type { OnboardingReader, RepoPolicyReader } from "./onboarding-models.js";
import type {
  AppRegistry,
  AuditReader,
  CostReader,
  EvidenceReader,
  GateBoard,
  HealthReader,
  JournalReader,
  KnowledgeIndex,
  QuotaReader,
  RunCatalog,
  RunnerFleet,
  ScanReader,
} from "./read-models.js";

/**
 * Everything the BFF needs from the outside world, as interfaces. The
 * composition root supplies the drivers (M44): no file under `src/routes`
 * imports Jira, ADO, Temporal, Prisma or Vault, and every test builds the
 * whole server from fakes.
 */

/** Injected clock — session expiry and signature timestamps are testable because of it. */
export interface Clock {
  now(): Date;
}

/** The message catalog (M104). Defaults to `@maestro/config`'s `t`. */
export interface MessageCatalog {
  t(locale: Locale, key: string, params?: Record<string, string>): string;
}

// ── identity (M8) ─────────────────────────────────────────────────────────────

export interface AuthenticatedUser {
  /** Audit actor in `user@corp` form (M33). */
  userId: string;
  username: string;
  groups: readonly string[];
  roles: readonly string[];
}

/**
 * The identity driver seam. MVP ships the local bcrypt provider; Aşama 2 adds
 * an LDAP-bind provider behind this same interface (M8) — which is why
 * `authenticate` takes a password rather than exposing a hash, and why nothing
 * outside the provider ever sees `UserRecord.passwordHash`.
 */
export interface IdentityProvider {
  readonly driver: string;
  /** `null` for "no such user" and "wrong password" alike — never say which. */
  authenticate(username: string, password: string): Promise<AuthenticatedUser | null>;
}

export interface UserRecord {
  username: string;
  userId: string;
  passwordHash: string;
  groups: readonly string[];
  roles: readonly string[];
  active: boolean;
}

/**
 * Where local accounts, roles and group memberships live (M8: from the DB).
 * The store never sees a plaintext password — hashing belongs to the identity
 * provider, which is the only file in this app that knows bcrypt exists.
 */
export interface UserDirectory {
  find(username: string): Promise<UserRecord | null>;
  upsert(record: UserRecord): Promise<void>;
  /** Off-boarding. A missing account is indistinguishable from a deactivated one at the guard. */
  remove(username: string): Promise<void>;
}

export interface SessionRecord {
  token: string;
  userId: string;
  username: string;
  groups: readonly string[];
  roles: readonly string[];
  /**
   * True when an AI tool holds this token on the user's behalf (M101). The
   * delegating human stays in the audit actor (`ai-via:<user>`), and gate
   * decisions are refused outright — approval is a human-only channel (M32).
   */
  delegated: boolean;
  issuedAt: string;
  expiresAt: string;
}

export interface SessionStore {
  create(record: SessionRecord): Promise<void>;
  get(token: string): Promise<SessionRecord | null>;
  delete(token: string): Promise<void>;
  /**
   * Every session this user holds, newest last. Logout and role changes act on
   * the ACCOUNT, not on the one token that happened to make the request: a
   * stolen token is not going to log itself out (M8/M32).
   */
  listByUser(userId: string): Promise<readonly SessionRecord[]>;
  /** Drop all of this user's sessions; returns how many were live. */
  deleteByUser(userId: string): Promise<number>;
}

// ── Jira project bindings (M102) ──────────────────────────────────────────────

export interface JiraBinding {
  projectKey: string;
  active: boolean;
  /** `auto` = every ticket; `opt_in` = only the `maestro` label or `/ai-start` (M48a). */
  triggerMode: "auto" | "opt_in";
  /** RoutingRule outcome; `null` sends the ticket to the assignment queue (M99). */
  appId: string | null;
  mode: WorkMode;
  dataClass: DataClass;
}

export interface JiraProjectBindings {
  /** `null` when the project was never bound — the single global webhook delivers everything (M102). */
  resolve(projectKey: string): Promise<JiraBinding | null>;
}

// ── gate ownership (M71) ──────────────────────────────────────────────────────

export interface GateDirectory {
  /**
   * The AD/Jira group that owns this gate for this project. `null` means the
   * step is not an approval gate here — a decision on it is refused, never
   * waved through.
   */
  ownerGroup(step: StepId, projectKey: string): Promise<string | null>;
}

// ── operational parameters (M71) ──────────────────────────────────────────────

export interface PendingParamChange {
  key: string;
  scopeRef: string | null;
  value: unknown;
  proposedBy: string;
  at: string;
}

export interface ParamStore {
  definitions(): Promise<readonly ParamDefinition[]>;
  values(): Promise<readonly ParamChange[]>;
  pending(): Promise<readonly PendingParamChange[]>;
  putPending(change: PendingParamChange): Promise<void>;
  clearPending(key: string, scopeRef: string | null): Promise<void>;
  apply(change: ParamChange): Promise<void>;
}

// ── analysis template designer (M108 / M83) ───────────────────────────────────

/** One designed section. Wire shape — what Studio sends and receives. */
export interface TemplateSection {
  /** Slug derived from the title; the key the generated Zod schema uses. */
  key: string;
  title: string;
  description: string;
  /** Instruction to the AI: HOW to fill this section. Goes into the prompt. */
  aiInstruction: string;
  /** Required sections fail closed — a missing one never reaches a gate. */
  required: boolean;
  format: "free_text" | "bullet_list" | "table" | "impact_matrix";
  example: string;
}

/**
 * A PUBLISHED template version. Immutable once written: a run pinned to
 * version 4 must still be able to read exactly what version 4 asked for (M83).
 */
export interface TemplateVersionRecord {
  name: string;
  version: number;
  sections: readonly TemplateSection[];
  publishedBy: string;
  publishedAt: string;
}

export interface TemplateHistoryEntry {
  version: number;
  at: string;
  author: string;
  summary: string;
}

export interface TemplateProjectBinding {
  projectKey: string;
  /** The version this project resolves to today. */
  version: number;
  /** Open runs still finishing on an older version (M83). */
  pinnedRuns: number;
}

export interface TemplateStore {
  /** Newest published version, or null before the first save. */
  latest(): Promise<TemplateVersionRecord | null>;
  /** A specific version — how a pinned run reads the template it started on. */
  get(version: number): Promise<TemplateVersionRecord | null>;
  history(): Promise<readonly TemplateHistoryEntry[]>;
  projects(): Promise<readonly TemplateProjectBinding[]>;
  /**
   * Append a new version. MUST reject anything other than `latest + 1` so two
   * authors saving at once cannot both publish version 5 and lose a draft.
   */
  publish(record: TemplateVersionRecord): Promise<void>;
}

// ── kill switch (M58) ─────────────────────────────────────────────────────────

export type KillSwitchLevel = "off" | "intake_only" | "all";

export interface KillSwitchState {
  level: KillSwitchLevel;
  actor: string;
  reason: string;
  at: string;
}

export interface KillSwitchStore {
  get(): Promise<KillSwitchState>;
  set(state: KillSwitchState): Promise<void>;
}

// ── webhook payload reading ───────────────────────────────────────────────────

/**
 * The driver-agnostic shape the BFF needs out of a VERIFIED Jira delivery.
 * `WorkPort` has no `parseEvent`, so the composition root injects the reader
 * built from the same driver (see RAPOR: this belongs on the port).
 */
export interface WorkEvent {
  kind: "issue" | "comment" | "other";
  ticketKey?: TicketKey;
  labels?: readonly string[];
}

export interface WorkEventReader {
  read(payload: unknown): WorkEvent;
}

/**
 * A driver capability the port does not declare: telling "this comment is not a
 * command" apart from "this comment is a malformed command". Without it the BFF
 * would have to stay silent on a typo, which M14/M105 forbid. Detected
 * structurally on the injected WorkPort — never by importing the driver.
 */
export interface CommandDiagnosis {
  envelope: CommandEnvelope | null;
  invalid: { command: string; messageKey: string; messageParams: Record<string, string> } | null;
}

export interface CommandDiagnostics {
  parseCommandDetailed(rawBody: unknown): CommandDiagnosis;
}

export function commandDiagnosticsOf(work: WorkPort): CommandDiagnostics | null {
  const candidate = work as Partial<CommandDiagnostics>;
  return typeof candidate.parseCommandDetailed === "function"
    ? (candidate as CommandDiagnostics)
    : null;
}

// ── the container ─────────────────────────────────────────────────────────────

export interface BffConfig {
  /**
   * The validated process environment (M6). Resolved through
   * `@maestro/config`'s `loadEnv` at boot, which refuses to return in
   * production when a connection value is missing — a half-configured BFF
   * never reaches the point of accepting a webhook.
   */
  env: Env;
  /** Appended to bare usernames to build the `user@corp` audit actor (M33). */
  actorDomain: string;
  /** Locale for Jira comments; the AI output language is a per-project param (M71). */
  locale: Locale;
  /** Session lifetime; 8 hours by M8. */
  sessionTtlMs: number;
  /** Label that opts a ticket into Maestro in `opt_in` projects (M48a). */
  optInLabel: string;
}

export interface BffDeps {
  work: WorkPort;
  workEvents: WorkEventReader;
  ci: CiPort;
  runs: RunGateway;
  audit: AuditChain;
  sessions: SessionStore;
  identity: IdentityProvider;
  users: UserDirectory;
  bindings: JiraProjectBindings;
  gates: GateDirectory;
  params: ParamStore;
  templates: TemplateStore;
  killSwitch: KillSwitchStore;
  /**
   * Studio's read side (M7). Grouped rather than spread across `BffDeps` so it
   * is obvious at a glance which dependencies exist to ANSWER questions and
   * which exist to change something — the write set above is the short one on
   * purpose.
   */
  read: ReadModels;
  messages?: MessageCatalog;
  clock?: Clock;
  config?: Partial<BffConfig>;
}

/** The injected read side; see `read-models.ts` for what each one owes Studio. */
export interface ReadModels {
  runs: RunCatalog;
  journal: JournalReader;
  gates: GateBoard;
  apps: AppRegistry;
  knowledge: KnowledgeIndex;
  runners: RunnerFleet;
  quota: QuotaReader;
  cost: CostReader;
  scans: ScanReader;
  evidence: EvidenceReader;
  audit: AuditReader;
  health: HealthReader;
  /** The onboarding wizard's lists and dry-run sample (M93/M102). */
  onboarding: OnboardingReader;
  /** `.maestro.yaml` as last observed per application (M52/M71). */
  repoPolicy: RepoPolicyReader;
}

export interface ResolvedDeps extends Omit<BffDeps, "messages" | "clock" | "config"> {
  messages: MessageCatalog;
  clock: Clock;
  config: BffConfig;
  diagnostics: CommandDiagnostics | null;
  /** Deliveries dropped because their project is unbound or paused (M102 counter). */
  counters: { droppedUnbound: number; droppedKillSwitch: number; invalidCommands: number };
}
