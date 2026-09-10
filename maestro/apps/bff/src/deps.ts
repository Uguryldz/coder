import type { AuditChain } from "@maestro/audit";
import type { Env } from "@maestro/config";
import type {
  CommandEnvelope,
  DataClass,
  FlowType,
  Locale,
  ParamChange,
  ParamDefinition,
  StepId,
  TicketKey,
  WorkMode,
} from "@maestro/contracts";
import type { CiPort, SecretPort, WorkPort } from "@maestro/ports";
import type {
  ClarifyReentryState,
  DeploymentConfigReader,
  TaniReportBuilder,
  VariantModelFacts,
} from "./config-health.js";
import type { ConnectionStore } from "./connection-store.js";
import type { ListeningStore } from "./listening-store.js";
import type { GuidanceStore } from "./guidance-store.js";
import type { ConnectorFetch } from "./connection-service.js";
import type { JiraWorkflowReader } from "./jira-workflow-model.js";
import type { RunGateway } from "./gateway.js";
import type { StudioReadModels } from "./read-studio.js";
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
  /**
   * True for the first-run bootstrap admin until it sets a real password
   * (banking standard, migration 0009). A `true` session is RESTRICTED: the
   * guard refuses every route but change-password, logout and session, so the
   * `admin`/`admin123` account can do nothing until it picks a policy-compliant
   * password. Absent/false for every normal account — the flag is planted only
   * by the seed and cleared by the change-password flow.
   */
  mustChangePassword?: boolean;
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
  /**
   * How this account should READ in the panel — "maestro (Jira bot)" rather
   * than `jira-bot-maestro`. Optional, and absent means "call it by its
   * username": every account an admin creates by hand is named by the person
   * typing it, so the username IS the readable name and a second field would
   * only be a second thing to keep in step.
   *
   * It exists for the accounts nobody types — the connector-provisioned bot
   * (`ensureBotUser`), whose username is a machine id and whose Jira identity
   * carries a real, human-chosen name. Without this field `PrismaUserDirectory`
   * wrote `displayName: record.username` on every upsert, so the bot's name in
   * "Kullanıcılar & roller" was overwritten with its slug by the next write
   * that touched the row — including its own re-provision.
   */
  displayName?: string;
  /**
   * The first-run bootstrap flag (migration 0009). True only for the seeded
   * `admin` account before it changes its password; the guard reads it back on
   * every request (the directory is the truth, the session a cache) and
   * restricts the session while it is set. Optional so a directory row written
   * before this field existed reads as `false` — an unrestricted normal
   * account, which is the safe default for a non-bootstrap user.
   */
  mustChangePassword?: boolean;
}

/**
 * Where local accounts, roles and group memberships live (M8: from the DB).
 * The store never sees a plaintext password — hashing belongs to the identity
 * provider, which is the only file in this app that knows bcrypt exists.
 */
export interface UserDirectory {
  find(username: string): Promise<UserRecord | null>;
  /**
   * Every account, for the admin users table (M8/M86). Bounded by a `limit`
   * because a bank directory is not a page — the caller asks for a window and
   * the store never hands back the whole table at once. Off-boarded (inactive)
   * accounts are INCLUDED: an admin auditing who still has access has to be able
   * to see the deactivated rows, not just the live ones.
   */
  list(limit: number): Promise<readonly UserRecord[]>;
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
  /**
   * The first-run bootstrap flag as of THIS request (migration 0009). Not
   * persisted in the session store — it is refreshed from the directory by the
   * guard on every request, exactly like roles and groups, so a change-password
   * that clears the flag takes effect on the next request rather than the next
   * login. `sessionOf(request).mustChangePassword` is therefore always current.
   */
  mustChangePassword?: boolean;
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
  /**
   * FROZEN CONTRACT, NO LONGER READ (0023). It used to gate intake: `opt_in`
   * meant "only a ticket carrying the `maestro` label or a `/ai-start` command",
   * and `jira-intake.ts` refused everything else before it had even looked at
   * the listening rules. That gate is gone — a trigger is defined in exactly one
   * place now, the listening rule (status · assignment · label · issue type).
   *
   * The field stays because `JiraProjectBinding.trigger` is a NOT NULL column
   * with existing rows behind it, and dropping it from the interface would mean
   * a migration on live bank data to delete something nobody reads. It is
   * written and never consulted; no new code should branch on it.
   */
  triggerMode: "auto" | "opt_in";
  /**
   * The bound application. `null` has two readings, disambiguated by the FLOW
   * intake decides: for a code-writing flow it sends the ticket to the
   * assignment queue (M99 tier ③, as it always has), while for `analiz` it is
   * the analysis-only binding — the run starts with no application and the
   * document is written from the ticket text.
   */
  appId: string | null;
  mode: WorkMode;
  dataClass: DataClass;
}

export interface JiraProjectBindings {
  /** `null` when the project was never bound — the single global webhook delivers everything (M102). */
  resolve(projectKey: string): Promise<JiraBinding | null>;
}

/**
 * Creating (or re-creating) a project's binding when an onboarding proposal is
 * APPROVED (M93/M102). Optional and wired exactly like `appRegistry`: a
 * deployment that has not wired it leaves the approve path answering 503-by-name
 * rather than pretending to bind. Present here means "an approved proposal can
 * write the live binding".
 *
 * Kept OFF `JiraProjectBindings` (which stays `resolve`-only) so the intake read
 * path never gains a write method it could call by accident. `bind` is an UPSERT
 * keyed on `projectKey`: re-approving a re-onboarded project overwrites its
 * binding rather than failing.
 */
export interface BindingWrite {
  projectKey: string;
  /** `TriggerModeE` (`auto` | `label` | `command`) as stored — mapped from the wizard's opt_in/automatic. */
  trigger: "auto" | "label" | "command";
  /** `active` puts the project live; the wizard's approval is what makes it live. */
  state: "draft" | "dry_run" | "active" | "paused" | "unbound";
  /** Exactly the shape `parseDefaults` reads back: `{ appId, mode, dataClass }`. */
  defaults: { appId: string | null; mode: WorkMode; dataClass: DataClass };
}

export interface BindingWriter {
  bind(binding: BindingWrite): Promise<void>;
}

// ── gate ownership (M71) ──────────────────────────────────────────────────────

/**
 * Bir kapının SAHİPLİĞİ — üç ayrı cevap, çünkü üçü üç ayrı davranış.
 *
 * `ownerGroup`'un tek `string | null`'ı bunları birbirine karıştırıyordu ve
 * karışıklık sahada bir kilitlenme üretti: `GATE_GROUPS` tanımlamamış bir
 * kurulumda rol adı bir grup adıymış gibi dizine soruluyor, Jira 404 diyor ve
 * her kapı kararı sessizce düşüyordu.
 */
export type GateOwner =
  /** Bu adım bir onay kapısı değil — karar REDDEDİLİR, asla geçirilmez. */
  | { kind: "not_a_gate" }
  /** Kapı bir dizin grubuna eşlenmiş — üyelik SORULUR, üye olmayan reddedilir. */
  | { kind: "group"; group: string }
  /**
   * Kapı var ama bu kurulumda eşlenmiş bir grup YOK.
   *
   * Sorulacak bir grup olmadığı için üyelik sorulmaz ve karar geçer; denetime
   * `membershipCheck: "unconfigured"` yazılır. Bir muafiyet değil, bir kurulum
   * gerçeğinin dürüstçe kaydedilmesi — bkz. `GateDecision.membershipCheck`.
   * `role` yine de taşınır: kararın hangi rol adına verildiği denetimde ve
   * kapı kaydında görünmeye devam etmeli.
   */
  | { kind: "unconfigured"; role: string };

export interface GateDirectory {
  /**
   * The AD/Jira group that owns this gate for this project. `null` means the
   * step is not an approval gate here — a decision on it is refused, never
   * waved through.
   *
   * Kapı eşlenmemişse de `null` döner; bu iki durumu AYIRMASI gereken çağıran
   * `ownerOf`u kullanmalı. Bu metot, grup adını bilmesi yeten okuyucular için
   * duruyor.
   */
  ownerGroup(step: StepId, projectKey: string): Promise<string | null>;
  /**
   * Aynı soru, ayrımı KAYBETMEDEN. Uygulaması olmayan bir dizin için isteğe
   * bağlı: yoksa çağıran `ownerGroup`a düşer ve bugünkü katı davranışı görür —
   * yani bu alanı eklemek hiçbir kurulumun davranışını kendiliğinden gevşetmez.
   */
  ownerOf?(step: StepId, projectKey: string): Promise<GateOwner>;
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
  /**
   * Persist a param version. `options.allowSelfApprove` waives the guarded
   * "approver ≠ author" rule for a master-admin self-approval the BFF has
   * already authorised; omitted/false keeps the strict two-person rule.
   */
  apply(change: ParamChange, options?: { allowSelfApprove?: boolean }): Promise<void>;
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

// ── corporate document template (M103r/M109 / M83) ────────────────────────────

/**
 * One uploaded corporate `.docx`, as STORED.
 *
 * The bytes are kept verbatim. That is the whole promise of M103r: the bank's
 * cover, header/footer, logo and style definitions survive because nothing
 * re-serialises them — `@maestro/publish` patches placeholders into the
 * original file. Anything this platform parsed and rewrote, it could also
 * silently lose.
 *
 * `placeholders` and `styles` are the SCAN of those bytes, recorded at upload
 * time rather than recomputed per read: the scan is what the document owner
 * approved, and a scanner improved next quarter must not retroactively change
 * what version 3 was said to contain.
 */
export interface DocTemplateRecord {
  fileName: string;
  /** Monotonic. A new upload publishes a new version; it never edits one (M83). */
  version: number;
  uploadedAt: string;
  uploadedBy: string;
  sizeBytes: number;
  /** Style names read out of the `.docx`. */
  styles: readonly string[];
  /** Every placeholder this platform looks for, found or not. */
  placeholders: readonly DocTemplatePlaceholder[];
  /** The file itself. Only the download path reads it. */
  content: Uint8Array;
}

export interface DocTemplatePlaceholder {
  token: string;
  /** Catalog key describing what gets written here (M104) — never prose. */
  descriptionKey: string;
  /** Where in the document it sits, as free text from the scan. */
  location: string;
  found: boolean;
}

/** A document this platform actually produced, for the screen's "outputs" list. */
export interface DocTemplateOutput {
  fileName: string;
  at: string;
  /** The template version it was rendered against — pinned per run (M83). */
  templateVersion: number;
}

export interface DocTemplateStore {
  /** Newest uploaded version, or null before the first upload. */
  latest(): Promise<DocTemplateRecord | null>;
  /**
   * A specific version. A run pinned to version 2 must still render against
   * version 2 after version 3 lands (M83), which is the only reason older
   * versions are kept at all.
   */
  get(version: number): Promise<DocTemplateRecord | null>;
  /**
   * Append a new version. MUST reject anything other than `latest + 1` so two
   * uploaders cannot both publish version 3 and lose one of the files.
   */
  publish(record: DocTemplateRecord): Promise<void>;
  /** Documents rendered against these templates, newest first. */
  outputs(limit: number): Promise<readonly DocTemplateOutput[]>;
}

// ── platform wiring, as Studio's settings screen reads it ─────────────────────

export type ConnectionStatus = "connected" | "degraded" | "unconfigured";

/**
 * One outbound connection. `credentialRef` is a Vault path or an auth method
 * and NEVER a secret: a console that can display a PAT is a console that can
 * leak it into a screenshot, so the value never leaves the process that holds
 * it.
 */
export interface ConnectionView {
  id: string;
  endpoint: string;
  status: ConnectionStatus;
  credentialRef: string;
  checkedAt: string | null;
}

export interface NotifyDriverView {
  channel: string;
  enabled: boolean;
  /** Where the channel delivers — a room, a mailbox, the ticket itself. */
  target: string;
}

export interface SettingsReader {
  connections(): Promise<readonly ConnectionView[]>;
  notifyDrivers(): Promise<readonly NotifyDriverView[]>;
}

// ── ticket → application routing (M99/M102) ───────────────────────────────────

export interface RoutingProjectView {
  projectKey: string;
  /**
   * `trigger` WAS HERE (0023) — `auto` | `label` | `command`, rendered as the
   * routing screen's "Tetikleme" column. It is gone from the wire because it
   * was gone from the decision: the project-wide trigger gate was retired and
   * intake now reads only the listening rules, so this field could only ever
   * tell an operator about a gate that no longer exists. A read model that
   * ships a stale answer is worse than one that ships none — the operator acts
   * on it. `JiraProjectBinding.trigger` stays in the schema (NOT NULL, no data
   * loss); nothing reads it.
   */
  /**
   * Named `apps` because that is what `Routing.tsx` reads. It was `appIds`,
   * which typechecked all the way through — the screen is untyped against this
   * interface — and crashed the page on `row.apps.length` the first time a
   * browser opened it. The screens own these names.
   */
  apps: readonly string[];
  /**
   * What the binding's state means for tickets arriving now, as a CATALOG KEY
   * (`routing.note.active_by_rule`, `routing.note.draft`, …) plus the parameters
   * the sentence needs.
   *
   * It used to be the finished English sentence. That put "every ticket starts
   * a run" and `draft: not yet bound` verbatim into the NOT column of a Turkish
   * screen — the BFF does not send sentences (M104). The key travels; the
   * screen renders it in the operator's language, the same way the `mode` and
   * `run.status` columns beside it already do.
   */
  noteKey: string;
  /** Substitutions for `noteKey` — currently only the unrecognised state name. */
  noteParams?: Readonly<Record<string, string>>;
}

export interface RoutingRuleView {
  ruleId: string;
  /**
   * The condition as a CATALOG KEY (`routing.condition.always`,
   * `routing.condition.component`, …) plus its substitutions — same reason as
   * `noteKey` above: this column used to arrive as English prose.
   */
  conditionKey: string;
  conditionParams?: Readonly<Record<string, string>>;
  /** Where the rule sends the ticket: an application id, or the queue. */
  effect: string;
  priority: number;
  projectKey: string;
}

export interface RoutingReader {
  projects(): Promise<readonly RoutingProjectView[]>;
  rules(): Promise<readonly RoutingRuleView[]>;
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
  /**
   * The issue's current status name, e.g. "Yapılacak". Carried because a
   * listening rule may key on it (`matchKind: "status"`), and the frozen
   * `TicketSnapshot` has no status field — so the webhook payload is the only
   * place the BFF can learn it without a second Jira round-trip.
   *
   * Absent means "the delivery did not say", which matches NO rule rather than
   * matching an empty one (see `flow-decision.ts`).
   */
  status?: string;
  /** The issue type name, e.g. "Hata"/"Bug" — the other thing a rule may key on. */
  issueType?: string;
  /**
   * AYNI İKİ ALANIN Jira KİMLİKLERİ (`fields.status.id`, `fields.issuetype.id`).
   *
   * Takım yönetimli (`style: "next-gen"`) bir projede JQL adları çözmüyor —
   * `issuetype = "Görev"` sıfır ticket döner, `issuetype = 10008` on dört — ve
   * o projede dinleme kuralı ADI değil İD'yi tutar. `flow-decision.ts` sayısal
   * bir `matchValue`'yu ticket'ın İD'siyle karşılaştırdığı için, teslimatın
   * taşıdığı bu iki alan okunmazsa kural bir tek ticket'ı bile eşleştiremez.
   *
   * Yokluğu, adların yokluğuyla aynı anlamda: "teslimat söylemedi" — ve o
   * durumda eşleşme ada düşer, yani bu alanlardan önceki davranış.
   */
  statusId?: string;
  issueTypeId?: string;
  /**
   * Who the issue is assigned to, in the same account form the listening rules
   * store. A rule naming an assignee only fires for tickets actually handed to
   * that account.
   */
  assignee?: string;
  /**
   * Değişikliği YAPAN hesap — `assignee` ile karıştırılmamalı: biri ticket'ın
   * kime düştüğünü, bu ise onu kimin ittiğini söyler.
   *
   * Tek bir iş için taşınıyor: netleştirme yeniden girişinde yankı ayıklaması
   * (`routes/webhooks.ts`). Maestro'nun kendi durum taşıması / yeniden ataması
   * da Jira'dan aynı biçimde geri gelir, ve `actor` bot'un kendisiyse o olay
   * bir cevap değil kendi sesidir.
   *
   * Yokluğu "bot değildi" demek DEĞİLDİR — teslimatın kimseyi adlandırmadığı
   * anlamına gelir; yankı koruması bu durumda tetiklememeyi seçer.
   */
  actor?: string;
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

/**
 * Creating or re-keying a LOCAL account (M8). A capability of the local bcrypt
 * provider, not of every `IdentityProvider`: the Aşama 2 AD/LDAP provider
 * authenticates against the directory and cannot mint a password there, so the
 * admin "add user" surface has to answer 503 rather than pretend to write a
 * credential the directory owns. Detected structurally, the same way command
 * diagnostics are — never by importing `LocalIdentityProvider`.
 */
export interface AccountProvisioner {
  provision(account: {
    username: string;
    userId: string;
    password: string;
    groups: readonly string[];
    roles: readonly string[];
  }): Promise<UserRecord>;
}

export function accountProvisionerOf(identity: IdentityProvider): AccountProvisioner | null {
  const candidate = identity as Partial<AccountProvisioner>;
  return typeof candidate.provision === "function" ? (candidate as AccountProvisioner) : null;
}

/**
 * Re-keying a LOCAL account's own password (M8 self-service + the first-run
 * bootstrap change, migration 0009). A capability of the local bcrypt provider,
 * not of every `IdentityProvider`: an AD/LDAP-backed login owns no password
 * this platform may rewrite, so the change-password route answers 503 rather
 * than pretend to change a credential the directory holds. Detected
 * structurally, the same way `AccountProvisioner` is — never by importing
 * `LocalIdentityProvider`.
 *
 * The contract: verify `currentPassword`, run the FULL password policy on
 * `newPassword` (so a bootstrap admin cannot set it back to `admin123`), re-key,
 * and clear `mustChangePassword`. Returns the re-keyed record, or `null` when
 * the account is missing/inactive or the current password is wrong.
 */
export interface PasswordChanger {
  changePassword(
    username: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<UserRecord | null>;
}

export function passwordChangerOf(identity: IdentityProvider): PasswordChanger | null {
  const candidate = identity as Partial<PasswordChanger>;
  return typeof candidate.changePassword === "function" ? (candidate as PasswordChanger) : null;
}

// ── application registry write (M93/M100) ─────────────────────────────────────

/**
 * The one field the wizard supplies about a repository, split into the two
 * columns the registry stores.
 *
 * `appId` is the repo's full name verbatim (`owner/repo`) — the same string the
 * screen picks from the live SCM list and the same one `assertBindable` matches
 * on, so registering it and then binding it cannot disagree about which repo was
 * meant. `adoProject`/`adoRepo` are the two halves the platform's `.docx`/SCM
 * adapters read (an ADO project is a GitHub owner here, M100).
 */
export interface AppRegistration {
  appId: string;
  displayName: string;
  adoProject: string;
  adoRepo: string;
  platform: string;
  /** The Jira project this repository belongs to; a project may own several. */
  jiraProjectKey?: string;
}

/**
 * Registering an application into the inventory (M93/M100). Optional and wired
 * exactly like `connections`: a deployment that has not wired it leaves the
 * onboarding submit at its older behaviour — file the binding proposal and
 * require the repo to have been onboarded already — rather than pretending to
 * write a row. Present here means "the wizard may create the app row itself".
 *
 * `register` is an UPSERT keyed on `appId`: re-running the wizard for a repo
 * already in the registry must not fail, because the operator's intent the
 * second time is the same as the first.
 */
export interface AppRegistryWriter {
  register(app: AppRegistration): Promise<void>;
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
  /**
   * What a ticket does when nothing more specific says otherwise.
   *
   * A deployment-level answer to "what is this install FOR". An analysis-only
   * install (the `analiz` profile — no SCM, no CI, no scanner) must not send
   * tickets into the engineering loop: there is nothing there to run, and the
   * run fails after the analysis has already been written and approved
   * (OPS-38). Absent means the full pipeline.
   *
   * A per-ticket listening rule is the finer-grained answer and now OVERRIDES
   * this one: `jira-intake.ts` matches the rules first and only falls back here
   * when no rule claims the ticket (`flow-decision.ts`).
   */
  defaultFlow?: FlowType | null;
  /**
   * The label that used to opt a ticket into an `opt_in` project (M48a).
   *
   * NOTHING ROUTES ON IT ANY MORE (0023): the project-wide opt-in gate was
   * retired and a trigger is defined only on a listening rule. It survives as
   * the substitution for the (now unreachable) `intake.not_opted_in` message —
   * removing it is a separate cleanup, not a display fix. No new code should
   * read this: a label triggers work by being named in a rule, not here.
   */
  optInLabel: string;
  /**
   * The accountId the ENGINE acts as (`MAESTRO_BOT_ACCOUNT_ID`), or "" when the
   * deployment never configured one.
   *
   * Read-only deployment fact, carried here for a single comparison: the
   * connector test checks the managed Jira connection's real owner against it
   * and warns when they differ. The BFF never authenticates as this account and
   * never calls Jira with it — it is a value to compare, not a credential.
   *
   * Empty means "not configured", which disables the check rather than failing
   * it: an install that predates the assignment-based flow has nothing to
   * compare and must not be told its connection is wrong.
   */
  engineBotAccountId: string;
}

/**
 * What the ticket sweep last did, when a deployment runs one.
 *
 * Optional because the sweep is: an install whose Jira webhook works has no
 * reason to poll. Absent means "not configured", which is a different answer
 * from "configured and finding nothing" — and an operator whose tickets are
 * not arriving needs to tell those two apart.
 *
 * A function rather than a value: the loop lives in the composition root
 * (`apps/deploy`), which this package may not import, and its status changes
 * every round.
 */
export type DiscoveryStatusReader = () => {
  readonly enabled: boolean;
  readonly intervalMs: number;
  readonly lastRunAt: string | null;
  readonly lastStarted: number;
  readonly rulesSearched: number;
  readonly lastError: string | null;
  /**
   * HAVUZDA KALAN İŞ — son tur, tur başı sınırına takılıp geride kaç iş
   * bıraktı. `null` = takılmadı, havuz boşaldı.
   *
   * Operatörün modeli "havuzda iş kaldığı sürece durmaz"; bu alan o modelin
   * PANELDEKİ ölçümü. Sayının kendisi bir alt sınır: sınıra takılan tur kalan
   * kuralları hiç aramamıştır, dolayısıyla gerçek birikim daha büyük olabilir.
   *
   * Opsiyonel, çünkü bu alanı tanımayan bir okuyucu (eski bir `apps/deploy`
   * imajı, ya da bir test sahtesi) hâlâ geçerli bir cevap veriyor — ve o
   * cevabın anlamı doğru olan: kalan bildirilmedi, yani gösterilecek bir
   * birikim yok.
   */
  readonly poolRemaining?: number | null;
  /**
   * Son turda OTOMATİK yeniden başlatılan ölü koşu sayısı.
   *
   * Ayrı bir alan, çünkü `lastStarted` ile karıştırılmamalı: 0 yeni ticket alan
   * ama 2 ölü koşuyu yeniden akışa alan bir tur ÇALIŞAN bir turdur, ve tek bir
   * sayı bunu söyleyemez.
   *
   * Opsiyonel, `poolRemaining` ile aynı gerekçe: bu alanı tanımayan bir okuyucu
   * hâlâ geçerli bir cevap veriyor.
   */
  readonly lastRestarted?: number;
  /**
   * Üst üste düştüğü için İNSANA DEVREDİLEN ticket sayısı — panelin operatöre
   * "bak" demesi gereken tek rakam.
   *
   * 0'dan büyükse kalıcı bir hata var ve robot artık denemiyor. Bu sayının
   * gösterilmemesi, frenin sessizce çalışması demek olurdu — döngünün kendisi
   * kadar kötü bir sessizlik.
   */
  readonly lastHandedOver?: number;
};

/**
 * Run one sweep NOW, instead of waiting for the next tick.
 *
 * Asked for directly after a sweep that was configured, healthy and finding
 * nothing: "tarama ok ama yine de panele gelmiyor, daha test butonu yok mu?".
 * Without it the only way to test a rule you just wrote is to wait out the
 * interval and read the container log — which needs a shell on the server, so
 * the person who can write rules cannot check their own work.
 *
 * Returns the keys the round took, so the panel can say what happened rather
 * than only that something ran. Optional for the same reason the status reader
 * is: a webhook-only install runs no sweep at all.
 */
export type DiscoveryRunner = () => Promise<readonly string[]>;

/**
 * KURALI DENE — bir kural TASLAĞINI Jira'ya sorup ne getirdiğini göstermek.
 *
 * `DiscoveryRunner` bir TUR koşar: kayıtlı kuralları arar ve bulduklarını
 * BAŞLATIR. Bu onun provası — hiçbir şey yazmaz, hiçbir koşu başlatmaz, kural
 * kaydetmez. Operatör kuralı KAYDETMEDEN önce filtresini ayarlayabilsin diye
 * var: bugüne kadar yeni bir kuralın doğru olup olmadığını öğrenmenin tek yolu
 * onu kaydedip bir tur beklemek ve konteyner log'unu okumaktı — yani kural
 * yazma yetkisi olan kişi kendi işini doğrulayamıyordu.
 *
 * Kompozisyon kökünde uygulanır (`apps/deploy`), çünkü JQL üretimi
 * (`jqlFor`) ve arama yapabilen sürücü orada; bu paket `apps/deploy`'u import
 * edemez (bağımlılık ters yönde). Böylece PANELDEKİ deneme ile TURUN kendisi
 * aynı `jqlFor`'u kullanır — farklı bir JQL üreten bir "test" butonu, test
 * ettiğini iddia ettiği şeyden başkasını test ederdi.
 *
 * Yokluğunda uç 503-by-name döner: arama sunmayan bir sürücüde (Azure DevOps)
 * ya da tarama hiç kurulmamışsa sessizce boş sonuç göstermek, bu ekranın var
 * olma sebebi olan sessiz-yanlışın aynısı olurdu.
 */

/**
 * "DEPOYU İNDİRMEYİ DENE" — depo eşlemesinin kuru provası.
 *
 * Depo eşlemesi sahada üç kez "çalışmıyor" diye bildirildi ve üçünde de arıza
 * eşlemede DEĞİLDİ: bir kez imajda `git` yoktu, bir kez `WORKSPACE_ROOT`
 * tanımsızdı, bir kez jetonun o organizasyona erişimi yoktu. Üçü de aynı
 * belirtiyi üretir — analiz kodu görmeden yazılır — ve üçünü ayırmanın tek
 * yolu bir koşuyu baştan sona izlemekti.
 *
 * Bu prova o üçünü saniyeler içinde ayırır: klonu GERÇEKTEN dener, sonucu
 * adıyla söyler (kaç dosya indi, hangi dal, hangi commit) ve başarısızsa
 * git'in kendi gerekçesini MASKELENMİŞ olarak verir. Koşu açmaz, ajana bir şey
 * göndermez, kredi harcamaz; açtığı klonu siler.
 */
export interface RepoCloneProbeResult {
  readonly ok: boolean;
  /** Denenen depo, `owner/repo`. */
  readonly repo: string;
  /** Klonun oturduğu dal — başarılıysa. */
  readonly branch?: string;
  /** `<kısa-sha> <konu>` — indirilenin GERÇEKTEN o depo olduğunun kanıtı. */
  readonly head?: string;
  /** `.git` dışındaki dosya sayısı. Sıfır, "indi ama boş" halini ayırır. */
  readonly fileCount?: number;
  /** Klon süresi, milisaniye. */
  readonly durationMs?: number;
  /** Başarısızlığın panelin çevirebileceği adı. */
  readonly messageKey?: string;
  /** git'in kendi cümlesi, jeton ve Authorization başlığı maskelenmiş. */
  readonly detail?: string;
}
export type RepoCloneProbe = (request: {
  readonly repo: string;
  readonly branch?: string;
}) => Promise<RepoCloneProbeResult>;

export type ListeningProbe = (draft: {
  readonly projectKey: string;
  readonly assigneeAccountId: string;
  readonly matchKind: "status" | "issuetype" | "assigned" | "label";
  readonly matchValue: string;
  readonly allowedStatuses?: readonly string[] | null;
}) => Promise<ListeningProbeResult>;

/** Bir denemede görülen tek ticket — kuralın sorduğu DÖRT ALAN, metin YOK. */
export type ProbeTicket = {
  readonly key: string;
  readonly status: string | null;
  readonly issueType: string | null;
  /**
   * AYNI İKİ ALANIN Jira KİMLİKLERİ.
   *
   * Denemenin bütün değeri "kuralın değeri ile ticket'ın değerini yan yana
   * koymak"; takım yönetimli bir projede kuralın değeri `10008`, tablonun
   * gösterdiği ise `"Görev"`dir. Kimlik sütunu olmadan operatör iki DOĞRU
   * satıra bakıp neden eşleşmediğini göremez — karşılaştırılan değerlerden
   * biri ekranda hiç yazmıyor olurdu.
   *
   * `null`/yokluk "arama sonucu bu alanı taşımadı" demek; opsiyonel, çünkü bu
   * alanlardan önce yazılmış deneme çağıranları ikisini de doldurmuyor ve
   * ekran o durumda bugünkü gibi yalnız adı gösterir.
   */
  readonly statusId?: string | null;
  readonly issueTypeId?: string | null;
  readonly assignee: string | null;
  readonly labels: readonly string[];
  /**
   * Bu ticket'ın ZATEN bir koşusu var mı.
   *
   * Ölçüldü: operatör 14 ticket bulan bir turda "0 alındı" görüp taramayı bozuk
   * sandı — oysa on dördünün de koşusu vardı ve tarama tam olarak işini
   * yapıyordu. Eşleşen bir ticket'ın yanında bunu söylemek, o yanılgının tek
   * çaresi.
   */
  readonly alreadyKnown: boolean;
};

export type ListeningProbeResult =
  | {
      readonly ok: true;
      /** Kuralın ürettiği JQL — operatör Jira'da da deneyebilsin diye aynen. */
      readonly jql: string;
      readonly matched: readonly ProbeTicket[];
      /**
       * EŞLEŞME YOKKEN projede AÇIK olan ticket'lar — ekranın asıl değeri.
       *
       * Operatör "kuralım Görev diyor ama hepsi Task yazıyor" ya da "hiçbiri
       * bota atanmamış" diyebilsin diye aynı sütunlarla. Eşleşme varken boş:
       * karşılaştırmaya gerek yok.
       */
      readonly projectSample: readonly ProbeTicket[];
      /** Karşılaştırma listesini üreten daraltılmış sorgu. */
      readonly sampleJql: string | null;
    }
  | {
      readonly ok: false;
      /**
       * Neden denenemedi — ADLANDIRILMIŞ sebep, serbest metin değil. Panel
       * bunu kendi katalogundan çevirir; `unbound_project` ile `no_bot_account`
       * operatörü iki ayrı ekrana gönderir.
       */
      readonly reason: string;
      /** Jira'nın kendi hata metni, varsa (sebep `search_failed` ise). */
      readonly detail?: string;
    };

/**
 * How ticket COMMANDS (`/approve`, `/reject <sebep>`) reach this deployment,
 * as the composition root can actually observe it.
 *
 * Exists so the setup wizard can ask "webhook mu, yoklama mı?" honestly instead
 * of writing a setting and hoping. Three facts, and each answers a question the
 * screen could otherwise only guess at:
 *
 *  · `canReadComments` — whether the configured work driver can read a comment
 *    thread AT ALL. The same check the poller makes (`canReadComments` in
 *    `apps/deploy/src/jira-poller.ts`); without it the wizard would offer
 *    polling on a driver that has no `listComments`, the operator would pick
 *    it, and nothing would ever poll. A setting silently accepted and not
 *    honoured is the worst outcome this endpoint prevents.
 *  · `appliesLive` — whether changing the setting takes effect without a
 *    service restart. The wizard shows one of two different sentences, and
 *    saying "hemen geçerli" on a deployment that needs a restart leaves an
 *    operator waiting on a gate nothing is polling.
 *  · `mode`/`pollSeconds` — what is in force RIGHT NOW, so the wizard opens on
 *    the platform's real answer rather than on its own default.
 *
 * A function rather than a value, like the discovery reader above: the
 * composition root owns the poller, this package may not import it, and the
 * answer changes when an operator saves a new one.
 */
export type CommandIntakeStatusReader = () => {
  /** What is in force now: webhook-only, polling, or both. */
  readonly mode: "webhook" | "poll" | "both";
  /** The interval in seconds when polling; 0 when nothing polls. */
  readonly pollSeconds: number;
  /** Whether the work driver can read a comment thread (poll is possible). */
  readonly canReadComments: boolean;
  /** Whether a saved change is picked up without a service restart. */
  readonly appliesLive: boolean;
  /**
   * Where the value in force came from: the stored parameter, the legacy
   * `JIRA_POLL_MS` environment variable, or the seeded default. The wizard says
   * so, because "kayıtlı ayar" and "env'den geliyor" send an operator to two
   * different places when the answer surprises them.
   */
  readonly source: "param" | "env" | "default";
};

export interface BffDeps {
  /**
   * See {@link CommandIntakeStatusReader}. Optional: a deployment that wires no
   * poller at all reports nothing, and the route answers a conservative
   * "webhook-only, restart required" rather than 503 — the wizard must still be
   * walkable on an install this endpoint has never heard of.
   */
  commandIntakeStatus?: CommandIntakeStatusReader;
  /** See {@link DiscoveryStatusReader}; absent on a webhook-only install. */
  discoveryStatus?: DiscoveryStatusReader;
  /** See {@link DiscoveryRunner}; absent on a webhook-only install. */
  discoveryRun?: DiscoveryRunner;
  /**
   * See {@link ListeningProbe} — "kuralı test et", the rules screen's dry run.
   * Absent where the work driver cannot search; the route says so by name.
   */
  listeningProbe?: ListeningProbe;
  /**
   * TICKET HANGİ DEPOYU İLGİLENDİRİYOR — koda sorarak.
   *
   * Depo eşlemesi operatöre "hangi depo" diye sorar ve bu, on depolu bir
   * projede işler. Sahada kırıldığı yer: bir Azure DevOps projesinde ONLARCA
   * depo var ve ticket'ın hangisini ilgilendirdiğini kimse bilmiyor — ne
   * operatör, ne kural. Bu seam o soruyu kodun kendisine sorar.
   *
   * Yokluğunda hiçbir şey değişmez: karar zinciri eskisi gibi eşlemeye ve
   * proje bağlamasına düşer. Arama bir EK, bir koşul değil.
   */
  repoSearch?: (request: {
    readonly text: string;
    readonly project?: string;
  }) => Promise<{ readonly repo: string; readonly why: string } | null>;
  /**
   * See {@link RepoCloneProbe} — "depoyu indirmeyi dene", the repo map's dry run.
   *
   * Absent where the install has no clone root; the route says so by name
   * rather than answering "başarısız", which would send the operator to look
   * for a permissions problem that is not there.
   */
  repoCloneProbe?: RepoCloneProbe;
  /**
   * Whether a sweep is wired, asked at call time.
   *
   * A composition root builds `deps` before it can build the sweep (the sweep
   * needs the work driver), so `discoveryRun` there is a closure that always
   * exists. This is how such a root still reports "webhook-only install"
   * honestly instead of failing the button with an error.
   */
  sweepConfigured?: () => boolean;
  /**
   * WHY there is no sweep, in the operator's language.
   *
   * "Not configured" and "this driver cannot search" send a person to two
   * different places — the `.env` file, or the connection screen. A single
   * generic message sends them to the wrong one half the time.
   */
  sweepUnavailableReason?: () => string;
  /**
   * NASIL kurulmuş — hangi Jira sürücüsü, tarama, webhook sırrı, statü
   * taşıma yeteneği. See {@link DeploymentConfigReader}.
   *
   * Aynı geç-bağlama sözleşmesi: `deps` kurulurken sürücü henüz kurulmamış
   * olabilir, o yüzden bir fonksiyon. Yokluğunda `/studio/config-health`
   * 503 vermez — bildirilmemiş satırları "bilinmiyor" olarak döner, çünkü
   * "bu kurulum bunu raporlamıyor" ile "bu kurulum bozuk" iki ayrı cevaptır
   * ve ikisini karıştırmak tam olarak bu ekranın kapattığı hata sınıfıdır.
   */
  deploymentConfig?: DeploymentConfigReader;
  /**
   * Netleştirme dönüşünün durumu, kökün hesapladığı hâliyle
   * (`bin/bff.ts:clarifyReentryStatus`). Asenkron: bot kimliği bağlantı
   * deposundan okunabilir (`bot-identity.ts`).
   */
  clarifyReentryStatus?: () => Promise<ClarifyReentryState>;
  /**
   * Varyantların model denetimi — `auditVariantModels`in panele çıkan yüzü.
   * Kök çağırır, burası yalnız okur; denetim mantığı `@maestro/db`de tektir.
   */
  variantModelAudit?: () => Promise<VariantModelFacts>;
  /**
   * Panelden indirilen TANI RAPORU — bitmiş bir HTML sayfası.
   *
   * Sayfayı bu paket ÜRETMEZ, üreteni çağırır. Üretici `apps/deploy`de
   * (`tani.ts`), çünkü rapor kompozisyon kökünün bildiği şeylerden oluşuyor:
   * sürücü, `.env`, Temporal geçidi, canlı Jira. Bağımlılık zaten o yönde
   * (`@maestro/deploy` → `@maestro/bff`), tersi mümkün değil — ve olmamalı da.
   *
   * `undefined` bir kurulumda uç 503-by-name döner: rapor üretemeyen bir
   * kurulumda boş bir HTML indirmek, bu ekranın kapatmaya çalıştığı
   * "yarım rapora bakıp sorun yok demek" hatasının ta kendisi olurdu.
   */
  taniReport?: TaniReportBuilder;
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
  /** The corporate `.docx` the analysis is rendered INTO (M103r/M109). */
  docTemplates: DocTemplateStore;
  /** Platform wiring, as the settings screen reads it. */
  settings: SettingsReader;
  /**
   * The managed-connector store (connector-management surface). Optional: a
   * deployment that has not wired it gets 503-by-name on `/studio/connections`,
   * the same convention as the other capabilities that refuse rather than
   * render an empty page. Absent here means "connectors are not editable in
   * this deployment", never "there are no connectors".
   */
  connections?: ConnectionStore;
  /**
   * The SecretPort that ENCIPHERS connector tokens (the DB-backed
   * `EncryptedSecretStore`). Deliberately its OWN secret port, not the Vault
   * driver the rest of the platform reads deployment secrets through: a console
   * writes here, and a console must not be able to write the Vault mount the
   * deployment provisions. Optional and paired with `connections` — both wired
   * together or the connector routes refuse.
   */
  connectorSecrets?: SecretPort;
  /**
   * Writes an application row into the inventory when the wizard is submitted
   * (M93/M100). Optional: a deployment that has not wired it leaves the
   * onboarding submit at its older proposal-only behaviour — the repo must have
   * been onboarded already — rather than 503-ing. Absent here means "the wizard
   * cannot create the app row in this deployment", never "no applications".
   */
  appRegistry?: AppRegistryWriter;
  /**
   * Writes a project's live binding when an onboarding proposal is approved
   * (M93/M102). Optional and paired with the onboarding approve path: a
   * deployment that has not wired it makes approve answer 503-by-name rather than
   * clearing the proposal without binding anything. Absent means "this deployment
   * cannot turn an approved proposal into a live binding".
   */
  bindingWriter?: BindingWriter;
  /**
   * The listening-rules store ("dinleme kuralları" surface). Optional: a
   * deployment that has not wired it gets 503-by-name on
   * `/studio/listening-rules`, the same convention as the other capabilities
   * that refuse rather than render an empty page. Absent here means "listening
   * rules are not editable in this deployment", never "there are no rules".
   */
  listening?: ListeningStore;
  /**
   * Bir alım kararının dökümünü alan yer — "hangi kural, hangi akış, hangi
   * ajan" (`intake-decision-log.ts`).
   *
   * Neden bir seam, neden `console.log` değil: bu paket kendi log'unu
   * seçmiyor (`classifyingFields`'in `onError`'ı da tam olarak bu yüzden
   * enjekte ediliyor — `ResolvedDeps`'te bir logger YOK ve olmamalı). Karar
   * dökümü, `apps/deploy` tarafında sürecin gerçek log'una bağlanır.
   *
   * Opsiyonel ve fail-soft: dökümü yazamamak bir alımı DÜŞÜRMEZ. Bir teşhis
   * satırı uğruna, çalışan bir ticket alımını reddetmek — bu dosyanın her
   * yerinde tekrarlanan gerekçe — yanlış takas olurdu.
   */
  decisionLog?: (line: string, markdown: string) => void;
  /**
   * Analysis-guidance store — the "öğren" knowledge library. Optional, same
   * 503-by-name convention as `listening`: absent means the deployment did not
   * wire it, never "there is no guidance". The enabled notes feed the analyst.
   */
  guidance?: GuidanceStore;
  /** Ticket→application routing (M99/M102), as the routing screen reads it. */
  routing: RoutingReader;
  /**
   * Reads a Jira project's workflow graph (statuses + transitions) off LIVE
   * Jira for the import screen (M102). Optional: a deployment that has not wired
   * a driver capable of it gets 503-by-name on `/studio/jira-workflow`, the same
   * convention as the other capabilities that refuse rather than render an empty
   * page. Absent here means "the live workflow cannot be read in this
   * deployment", never "this project has no workflow". Read-only — nothing here
   * moves an issue.
   */
  jiraWorkflow?: JiraWorkflowReader;
  killSwitch: KillSwitchStore;
  /**
   * Studio's read side (M7). Grouped rather than spread across `BffDeps` so it
   * is obvious at a glance which dependencies exist to ANSWER questions and
   * which exist to change something — the write set above is the short one on
   * purpose.
   */
  read: ReadModels;
  /**
   * The read side for the last eight screens (M7), model-by-model optional.
   *
   * Separate from `read` because these are optional INDIVIDUALLY: this
   * deployment has variant rows and an audit chain but no golden-ticket table,
   * so it wires two of the three and the routes behind the rest refuse by name.
   * Folding them into `ReadModels` would force every composition root and every
   * test fixture to supply all of them, and the usual way that pressure gets
   * released is a stub that answers "empty" — the exact failure this project
   * keeps designing against. Absent here means 503 with a reason, never `[]`.
   */
  studio?: StudioReadModels;
  messages?: MessageCatalog;
  clock?: Clock;
  config?: Partial<BffConfig>;
  /**
   * How the connector LIVE test reaches a target (Jira, GitHub, an LLM,
   * Vault). Optional so a deployment gets the real `fetch` and a test injects a
   * stub with no network. The URL the test calls is built from the STORED
   * `baseUrl`, never from a request body — a caller cannot point it at a host of
   * their choosing.
   */
  connectorFetch?: ConnectorFetch;
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

export interface ResolvedDeps
  extends Omit<BffDeps, "messages" | "clock" | "config" | "studio" | "connectorFetch"> {
  messages: MessageCatalog;
  clock: Clock;
  config: BffConfig;
  /** Always present after `resolveDeps`; individual models stay optional. */
  studio: StudioReadModels;
  /** Resolved to the real `fetch` when a deployment injects none. */
  connectorFetch: ConnectorFetch;
  diagnostics: CommandDiagnostics | null;
  /** Deliveries dropped because their project is unbound or paused (M102 counter). */
  counters: { droppedUnbound: number; droppedKillSwitch: number; invalidCommands: number };
}
