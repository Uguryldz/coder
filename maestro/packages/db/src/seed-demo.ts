import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import type {
  AuditAction,
  DataClass,
  JournalActor,
  JournalKind,
  RiskTier,
  StepId,
  WorkMode,
} from "@maestro/contracts";

/**
 * Demo dataset — the mock's data, as rows.
 *
 * Wave 1 requirement (insa-plani.md): the seed *is* the mock dataset, so a
 * fresh install opens Studio already populated (5 applications + repo cards,
 * 4 bound Jira projects + routing rules, 22 tickets in a realistic status
 * spread, journal entries, signed gate decisions and a verifiable audit
 * chain). Nothing is migrated from v1.
 *
 * Everything is derived from `DEMO_NOW`, so re-running produces byte-identical
 * rows — the dataset is a fixture, not random noise.
 */

/** The mock's "now": 8 Aug 2026, 14:20 Istanbul time. */
export const DEMO_NOW = new Date("2026-08-08T11:20:00.000Z");

const HOUR = 3_600_000;

/** A timestamp `hours` before `DEMO_NOW`. */
function ago(hours: number): Date {
  return new Date(DEMO_NOW.getTime() - hours * HOUR);
}

/** Istanbul wall-clock helper for the hand-transcribed mock journal. */
function ist(iso: string): Date {
  return new Date(`${iso}+03:00`);
}

/** Deterministic run id derived from the ticket key (RunId: opaque, min 8). */
export function demoRunId(ticketKey: string): string {
  return `run-${ticketKey.toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// Applications & repo cards (M100)
// ---------------------------------------------------------------------------

const APPLICATIONS: Prisma.ApplicationCreateManyInput[] = [
  {
    appId: "ugurpay",
    displayName: "ugurpay",
    adoProject: "Odeme",
    adoRepo: "ugurpay",
    platform: "linux-node",
    jiraComponent: "pay-web/api",
    maestroYamlPresent: true,
    createdVia: "import",
  },
  {
    appId: "ugurweb",
    displayName: "ugurweb",
    adoProject: "Web",
    adoRepo: "ugurweb",
    platform: "linux-node",
    jiraComponent: "web",
    maestroYamlPresent: true,
    createdVia: "import",
  },
  {
    appId: "ugurmobil-ios",
    displayName: "ugurmobil-ios",
    adoProject: "Mobil",
    adoRepo: "ugurmobil-ios",
    platform: "macos-xcode",
    jiraComponent: "ios",
    maestroYamlPresent: true,
    createdVia: "import",
  },
  {
    appId: "ugurmobil-android",
    displayName: "ugurmobil-android",
    adoProject: "Mobil",
    adoRepo: "ugurmobil-android",
    platform: "linux-android",
    jiraComponent: "android",
    maestroYamlPresent: true,
    createdVia: "import",
  },
  {
    appId: "ugurmasaustu",
    displayName: "ugurmasaüstü",
    adoProject: "Sube",
    adoRepo: "ugurmasaustu",
    platform: "windows-dotnet",
    jiraComponent: "sube-masaustu",
    maestroYamlPresent: false, // onboarding will propose the file by PR (M93)
    createdVia: "onboarding",
  },
];

const REPO_CARD_MODULES: Record<string, { name: string; path: string; summary: string }[]> = {
  ugurpay: [
    { name: "payments-api", path: "apps/api/payments", summary: "Payment, refund and limit endpoints" },
    { name: "limits", path: "packages/limits", summary: "Credit limit rules and validation" },
    { name: "web", path: "apps/web", summary: "Customer-facing Next.js screens" },
  ],
  ugurweb: [
    { name: "components", path: "src/components", summary: "Shared React component library" },
    { name: "pages", path: "src/pages", summary: "Public marketing and login pages" },
  ],
  "ugurmobil-ios": [
    { name: "Auth", path: "Sources/Auth", summary: "Login, Face ID and certificate pinning" },
    { name: "Payments", path: "Sources/Payments", summary: "Transfer and limit screens" },
  ],
  "ugurmobil-android": [
    { name: "auth", path: "app/src/main/auth", summary: "Login and biometric flows" },
    { name: "notifications", path: "app/src/main/notifications", summary: "Push permissions and channels" },
  ],
  ugurmasaustu: [
    { name: "Reporting", path: "src/Reporting", summary: "Branch reporting and export" },
    { name: "Eft", path: "src/Eft", summary: "Bulk EFT file import" },
  ],
};

const REPO_CARDS: Prisma.RepoCardCreateManyInput[] = Object.entries(REPO_CARD_MODULES).map(
  ([appId, modules], index) => ({
    appId,
    version: 1,
    modulesJson: modules,
    generatedFromSha: `a1b2c3d4e5f60718293a4b5c6d7e8f90${index}0000000`.slice(0, 40),
    updatedAt: ago(24 * (index + 2)),
  }),
);

// ---------------------------------------------------------------------------
// Jira bindings & routing rules (M102 / M99)
// ---------------------------------------------------------------------------

const BINDINGS: Prisma.JiraProjectBindingCreateManyInput[] = [
  {
    projectKey: "UGURPAY",
    trigger: "auto",
    triggerLabel: "maestro",
    defaultsJson: { mode: "full_auto", dataClass: "dahili" },
    state: "active",
    dryRunSampleSize: 20,
    lastDryRunAt: ago(24 * 8),
    version: 3,
  },
  {
    projectKey: "UGURWEB",
    trigger: "label",
    triggerLabel: "maestro",
    defaultsJson: { mode: "full_auto", dataClass: "dahili" },
    state: "active",
    dryRunSampleSize: 20,
    lastDryRunAt: ago(24 * 7),
    version: 2,
  },
  {
    projectKey: "UGURMOB",
    trigger: "command", // /ai-start
    triggerLabel: "maestro",
    defaultsJson: { mode: "full_auto", dataClass: "dahili" },
    state: "active",
    dryRunSampleSize: 20,
    lastDryRunAt: ago(24 * 6),
    version: 2,
  },
  {
    projectKey: "UGURDESK",
    trigger: "auto",
    triggerLabel: "maestro",
    defaultsJson: { mode: "full_auto", dataClass: "dahili" },
    state: "active",
    dryRunSampleSize: 20,
    lastDryRunAt: ago(24 * 5),
    version: 1,
  },
  {
    // Onboarding wizard step 3/4 — not yet dry-run, so it cannot be activated.
    projectKey: "UGURKREDI",
    trigger: "label",
    triggerLabel: "maestro",
    defaultsJson: { mode: "ai_assist", dataClass: "dahili" },
    state: "draft",
    dryRunSampleSize: 20,
    lastDryRunAt: null,
    version: 1,
  },
];

const ROUTING_RULES: Prisma.RoutingRuleCreateManyInput[] = [
  {
    ruleId: "rule-1",
    projectKey: "UGURPAY",
    conditionJson: { type: "always" },
    effectJson: { appId: "ugurpay", mode: "full_auto" },
    priority: 1,
  },
  {
    ruleId: "rule-2",
    projectKey: "UGURWEB",
    conditionJson: { type: "always" },
    effectJson: { appId: "ugurweb", mode: "full_auto" },
    priority: 2,
  },
  {
    ruleId: "rule-3",
    projectKey: "UGURMOB",
    conditionJson: { type: "component", component: "ios" },
    effectJson: { appId: "ugurmobil-ios", mode: "full_auto" },
    priority: 3,
  },
  {
    ruleId: "rule-4",
    projectKey: "UGURMOB",
    conditionJson: { type: "component", component: "android" },
    effectJson: { appId: "ugurmobil-android", mode: "full_auto" },
    priority: 4,
  },
  {
    ruleId: "rule-6",
    projectKey: "UGURDESK",
    conditionJson: { type: "always" },
    effectJson: { appId: "ugurmasaustu", mode: "full_auto" },
    priority: 6,
  },
  {
    // Rule 5 of the mock ("component missing") is deliberately absent: no match
    // means tier ② (AI suggestion), which is the absence of a rule (M14/M99).
    // Rule 7 is the org-wide data-class guard.
    ruleId: "rule-7",
    projectKey: "UGURDESK",
    conditionJson: { type: "label", label: "musteri-verisi" },
    effectJson: { mode: "human_lead", dataClass: "gizli" },
    priority: 7,
  },
];

// ---------------------------------------------------------------------------
// Tickets → workflow runs
// ---------------------------------------------------------------------------

/**
 * Mock step indices are positions in `STEP_IDS` (the mock's STEPS table is the
 * same list in the same order), so the demo carries contract step ids directly.
 */
interface DemoTicket {
  key: string;
  appId: string | null;
  mode: WorkMode;
  risk: RiskTier | null;
  dataClass: DataClass;
  step: StepId;
  status: "running" | "gate" | "queued" | "fail" | "handover" | "done" | "cancelled";
  /** Age of the run in hours. */
  ageHours: number;
  /** Hours since the last state change. */
  idleHours: number;
  match: Prisma.InputJsonValue;
}

const RULE_MATCH = (ruleId: string, appId: string): Prisma.InputJsonValue => ({
  via: "rule",
  ruleId,
  appId,
});

const FANOUT_MATCH = (appId: string): Prisma.InputJsonValue => ({
  via: "analysis_fanout",
  parentTicketKey: "UGURPAY-500",
  appId,
});

export const DEMO_TICKETS: readonly DemoTicket[] = [
  // --- UGURPAY-500 fan-out family (M100) -----------------------------------
  {
    key: "UGURPAY-500",
    appId: null, // coordination parent: the work lives in the children
    mode: "full_auto",
    risk: "orta",
    dataClass: "dahili",
    step: "3",
    status: "running",
    ageHours: 144,
    idleHours: 2,
    match: RULE_MATCH("rule-1", "ugurpay"),
  },
  {
    key: "UGURPAY-501",
    appId: "ugurpay",
    mode: "full_auto",
    risk: "orta",
    dataClass: "dahili",
    step: "12",
    status: "gate",
    ageHours: 144,
    idleHours: 52,
    match: FANOUT_MATCH("ugurpay"),
  },
  {
    key: "UGURPAY-502",
    appId: "ugurmobil-ios",
    mode: "full_auto",
    risk: "orta",
    dataClass: "dahili",
    step: "7",
    status: "running",
    ageHours: 96,
    idleHours: 1,
    match: FANOUT_MATCH("ugurmobil-ios"),
  },
  {
    key: "UGURPAY-503",
    appId: "ugurmobil-android",
    mode: "ai_assist",
    risk: "orta",
    dataClass: "dahili",
    step: "6a",
    status: "running",
    ageHours: 96,
    idleHours: 1,
    match: FANOUT_MATCH("ugurmobil-android"),
  },
  {
    key: "UGURPAY-504",
    appId: "ugurmasaustu",
    mode: "full_auto",
    risk: "orta",
    dataClass: "dahili",
    step: "4",
    status: "gate",
    ageHours: 384,
    idleHours: 386,
    match: FANOUT_MATCH("ugurmasaustu"),
  },
  // --- standalone UGURPAY tickets ------------------------------------------
  {
    key: "UGURPAY-123",
    appId: "ugurpay",
    mode: "full_auto",
    risk: "dusuk",
    dataClass: "dahili",
    step: "11",
    status: "gate",
    ageHours: 24,
    idleHours: 1,
    match: RULE_MATCH("rule-1", "ugurpay"),
  },
  {
    key: "UGURPAY-712",
    appId: "ugurpay",
    mode: "full_auto",
    risk: "orta",
    dataClass: "dahili",
    step: "2b",
    status: "gate",
    ageHours: 24,
    idleHours: 20,
    match: RULE_MATCH("rule-1", "ugurpay"),
  },
  {
    key: "UGURPAY-689",
    appId: "ugurpay",
    mode: "full_auto",
    risk: "dusuk",
    dataClass: "dahili",
    step: "3",
    status: "queued", // subscription quota window (M55)
    ageHours: 3,
    idleHours: 1,
    match: RULE_MATCH("rule-1", "ugurpay"),
  },
  {
    key: "UGURPAY-478",
    appId: "ugurpay",
    mode: "full_auto",
    risk: "dusuk",
    dataClass: "dahili",
    step: "13",
    status: "done",
    ageHours: 168,
    idleHours: 144,
    match: RULE_MATCH("rule-1", "ugurpay"),
  },
  {
    key: "UGURPAY-455",
    appId: "ugurpay",
    mode: "full_auto",
    risk: "dusuk",
    dataClass: "dahili",
    step: "13",
    status: "done",
    ageHours: 288,
    idleHours: 264,
    match: RULE_MATCH("rule-1", "ugurpay"),
  },
  // --- UGURWEB --------------------------------------------------------------
  {
    key: "UGURWEB-88",
    appId: "ugurweb",
    mode: "human_lead",
    risk: "dusuk",
    dataClass: "dahili",
    step: "6b",
    status: "running",
    ageHours: 72,
    idleHours: 2,
    match: RULE_MATCH("rule-2", "ugurweb"),
  },
  {
    key: "UGURWEB-91",
    appId: "ugurweb",
    mode: "full_auto",
    risk: "dusuk",
    dataClass: "dahili",
    step: "6a",
    status: "running",
    ageHours: 5,
    idleHours: 1,
    match: RULE_MATCH("rule-2", "ugurweb"),
  },
  {
    key: "UGURWEB-72",
    appId: "ugurweb",
    mode: "full_auto",
    risk: "orta",
    dataClass: "dahili",
    step: "9",
    status: "gate",
    ageHours: 48,
    idleHours: 4,
    match: RULE_MATCH("rule-2", "ugurweb"),
  },
  {
    key: "UGURWEB-83",
    appId: "ugurweb",
    mode: "full_auto",
    risk: "dusuk",
    dataClass: "dahili",
    step: "13",
    status: "done",
    ageHours: 240,
    idleHours: 216,
    match: RULE_MATCH("rule-2", "ugurweb"),
  },
  {
    key: "UGURWEB-95",
    appId: "ugurweb",
    mode: "human_only", // Maestro only watches and collects evidence
    risk: "dusuk",
    dataClass: "dahili",
    step: "6a",
    status: "running",
    ageHours: 24,
    idleHours: 3,
    match: RULE_MATCH("rule-2", "ugurweb"),
  },
  // --- UGURMOB --------------------------------------------------------------
  {
    key: "UGURMOB-201",
    appId: "ugurmobil-ios",
    mode: "full_auto",
    risk: "kritik",
    dataClass: "dahili",
    step: "10",
    status: "running",
    ageHours: 48,
    idleHours: 1,
    // Tier ② of M99: no component on the ticket, AI suggested the app and a
    // human confirmed it at the analysis gate.
    match: {
      via: "ai_suggestion",
      appId: "ugurmobil-ios",
      confidence: 0.94,
      validatedAtGate: true,
    },
  },
  {
    key: "UGURMOB-166",
    appId: "ugurmobil-ios",
    mode: "full_auto",
    risk: "kritik",
    dataClass: "dahili",
    step: "13",
    status: "done",
    ageHours: 336,
    idleHours: 312,
    match: RULE_MATCH("rule-3", "ugurmobil-ios"),
  },
  {
    key: "UGURMOB-188",
    appId: "ugurmobil-android",
    mode: "full_auto",
    risk: "dusuk",
    dataClass: "dahili",
    step: "5",
    status: "gate",
    ageHours: 7,
    idleHours: 3,
    match: RULE_MATCH("rule-4", "ugurmobil-android"),
  },
  // --- UGURDESK -------------------------------------------------------------
  {
    key: "UGURDESK-45",
    appId: "ugurmasaustu",
    mode: "full_auto",
    risk: "dusuk",
    dataClass: "dahili",
    step: "10b",
    status: "fail", // CI red: 3 vstest scenarios, the agent is fixing them
    ageHours: 48,
    idleHours: 3,
    match: RULE_MATCH("rule-6", "ugurmasaustu"),
  },
  {
    key: "UGURDESK-52",
    appId: "ugurmasaustu",
    mode: "full_auto",
    risk: "kritik",
    dataClass: "dahili",
    step: "6a",
    status: "running",
    ageHours: 6,
    idleHours: 1,
    match: RULE_MATCH("rule-6", "ugurmasaustu"),
  },
  {
    key: "UGURDESK-39",
    appId: "ugurmasaustu",
    mode: "full_auto",
    risk: "dusuk",
    dataClass: "dahili",
    step: "13",
    status: "done",
    ageHours: 288,
    idleHours: 264,
    match: RULE_MATCH("rule-6", "ugurmasaustu"),
  },
  // --- greenfield (M42) -----------------------------------------------------
  {
    key: "UGURPAY-600",
    appId: null, // no repo yet; the record is created during onboarding
    mode: "full_auto",
    risk: "kritik",
    dataClass: "dahili",
    step: "5",
    status: "gate",
    ageHours: 24,
    idleHours: 5,
    match: { via: "onboarding" },
  },
];

const RUNS: Prisma.WorkflowRunCreateManyInput[] = DEMO_TICKETS.map((t) => ({
  id: demoRunId(t.key),
  ticketKey: t.key,
  appId: t.appId,
  mode: t.mode,
  risk: t.risk,
  dataClass: t.dataClass,
  step: t.step,
  status: t.status,
  matchJson: t.match,
  startedAt: ago(t.ageHours),
  updatedAt: ago(t.idleHours),
}));

// ---------------------------------------------------------------------------
// Step events — including the signed gate decisions
// ---------------------------------------------------------------------------

interface DemoGate {
  ticketKey: string;
  step: StepId;
  decision: "approve" | "reject";
  actorUserId: string;
  actorGroup: string;
  signatureSeq: number;
  source: "jira" | "studio";
  at: Date;
  reason?: string;
}

/**
 * Signed approvals (M51): the primary channel is a Jira `/approve` comment,
 * Studio is secondary. `sodVerified` is always true — a decision that fails
 * separation of duties is refused before it is ever recorded.
 */
export const DEMO_GATE_DECISIONS: readonly DemoGate[] = [
  {
    ticketKey: "UGURPAY-501",
    step: "4",
    decision: "approve",
    actorUserId: "ayse.kaya@ugurbank.local",
    actorGroup: "product-owners",
    signatureSeq: 81390,
    source: "jira",
    at: ist("2026-07-31T14:20:00"),
  },
  {
    ticketKey: "UGURPAY-501",
    step: "5",
    decision: "approve",
    actorUserId: "mert.demir@ugurbank.local",
    actorGroup: "tech-leads",
    signatureSeq: 81402,
    source: "jira",
    at: ist("2026-08-01T09:15:00"),
  },
  {
    ticketKey: "UGURPAY-501",
    step: "9",
    decision: "approve",
    actorUserId: "deniz.yalcin@ugurbank.local",
    actorGroup: "qa",
    signatureSeq: 81409,
    source: "jira",
    at: ist("2026-08-01T13:05:00"),
  },
  {
    ticketKey: "UGURPAY-501",
    step: "11",
    decision: "approve",
    actorUserId: "deniz.yalcin@ugurbank.local",
    actorGroup: "qa",
    signatureSeq: 81412,
    source: "studio",
    at: ist("2026-08-01T14:02:00"),
  },
  {
    // The PR thread that sent UGURPAY-501 back to engineering (step 12b).
    ticketKey: "UGURPAY-501",
    step: "12",
    decision: "reject",
    actorUserId: "ayse.kaya@ugurbank.local",
    actorGroup: "tech-leads",
    signatureSeq: 81415,
    source: "jira",
    at: ist("2026-08-04T16:11:00"),
    reason: "limit üst sınırı konfigden okunmalı, env değil",
  },
  {
    ticketKey: "UGURMOB-166",
    step: "5",
    decision: "approve",
    actorUserId: "mert.demir@ugurbank.local",
    actorGroup: "tech-leads",
    signatureSeq: 81201,
    source: "jira",
    at: ago(336 - 20),
  },
  {
    ticketKey: "UGURMOB-166",
    step: "12",
    decision: "approve",
    // Not the admin: approving is a group right, and maestro-admins is not
    // an approver group (the SoD matrix in the mock's users screen).
    actorUserId: "ayse.kaya@ugurbank.local",
    actorGroup: "tech-leads",
    signatureSeq: 81244,
    source: "jira",
    at: ago(312),
  },
  {
    ticketKey: "UGURPAY-478",
    step: "5",
    decision: "approve",
    actorUserId: "mert.demir@ugurbank.local",
    actorGroup: "tech-leads",
    signatureSeq: 81301,
    source: "jira",
    at: ago(168 - 12),
  },
  {
    ticketKey: "UGURPAY-478",
    step: "12",
    decision: "approve",
    actorUserId: "ayse.kaya@ugurbank.local",
    actorGroup: "tech-leads",
    signatureSeq: 81333,
    source: "jira",
    at: ago(144),
  },
];

const GATE_STEP_EVENTS: Prisma.StepEventCreateManyInput[] = DEMO_GATE_DECISIONS.map((g) => ({
  runId: demoRunId(g.ticketKey),
  step: g.step,
  kind: "human_gate",
  at: g.at,
  dataJson: {
    step: g.step,
    decision: g.decision,
    actorUserId: g.actorUserId,
    actorGroup: g.actorGroup,
    sodVerified: true,
    signatureSeq: g.signatureSeq,
    source: g.source,
    at: g.at.toISOString(),
    ...(g.reason === undefined ? {} : { reason: g.reason }),
  },
}));

/** One "entered this step" event per run, so every run has a visible trail. */
const ENTER_STEP_EVENTS: Prisma.StepEventCreateManyInput[] = DEMO_TICKETS.map((t) => ({
  runId: demoRunId(t.key),
  step: t.step,
  kind: t.status === "gate" ? "human_gate" : t.status === "done" ? "system" : "ai",
  at: ago(t.idleHours),
  dataJson: { event: "step_entered", status: t.status },
}));

// ---------------------------------------------------------------------------
// Journal (M30) — append-only
// ---------------------------------------------------------------------------

interface DemoJournalEntry {
  at: Date;
  actor: JournalActor;
  kind: JournalKind;
  title: string;
  detail: string;
  cost?: { usd: number; model: string };
}

/** The mock's full journal for UGURPAY-501 — the ticket the detail screen opens. */
const UGURPAY_501_JOURNAL: DemoJournalEntry[] = [
  { at: ist("2026-07-31T09:02:00"), actor: "system", kind: "intake", title: "Ticket alındı", detail: "UGURPAY-501 webhook ile geldi · imza doğrulandı · work mode: full_auto (label: mode:full-auto)" },
  { at: ist("2026-07-31T09:03:00"), actor: "ai", kind: "intake", title: "Intake — eksik bilgi", detail: "Kabul kriteri ve limit üst sınırı belirtilmemiş. Reporter'a 2 soru soruldu.", cost: { usd: 0.01, model: "claude-haiku-4-5" } },
  { at: ist("2026-07-31T11:40:00"), actor: "human", kind: "clarification", title: "Reporter yanıtı (Can Ö.)", detail: "Üst sınır risk ekibince belirlenen değerden okunacak; kriterler ticket'a eklendi." },
  { at: ist("2026-07-31T11:41:00"), actor: "ai", kind: "intake", title: "Intake — tamam", detail: "Ticket tam. Analiz adımına geçiliyor.", cost: { usd: 0.01, model: "claude-haiku-4-5" } },
  { at: ist("2026-07-31T11:44:00"), actor: "ai", kind: "discovery", title: "Repo keşfi", detail: "Agent SDK salt-okunur oturum · 214 dosya tarandı · etkilenen 3 modül tespit edildi.", cost: { usd: 0.34, model: "claude-opus-5" } },
  { at: ist("2026-07-31T11:58:00"), actor: "ai", kind: "analysis", title: "Analiz üretildi", detail: "Şablon v3 · 7/7 bölüm dolu · doğrulama geçti · etki matrisi: 4 platform.", cost: { usd: 1.12, model: "claude-opus-5" } },
  { at: ist("2026-07-31T12:02:00"), actor: "system", kind: "analysis", title: "Alt ticket'lar açıldı", detail: "Etki matrisinden: UGURPAY-501/502/503/504 · bağımlılık: 501 → diğerleri" },
  { at: ist("2026-07-31T14:20:00"), actor: "human", kind: "gate", title: "PO onayı — Ayşe K.", detail: "/approve · grup: product-owners ✓ · imza #81390" },
  { at: ist("2026-08-01T09:15:00"), actor: "human", kind: "gate", title: "Tech Lead onayı — Mert D.", detail: "/approve · SoD ✓ (PO ≠ TL) · not: 'limit sabit kodlanmasın' · imza #81402" },
  { at: ist("2026-08-01T09:16:00"), actor: "ai", kind: "engineering", title: "Engineer oturumu #1 başladı", detail: "lnx-01 · workspace oluşturuldu · klon + install 2dk 51sn" },
  { at: ist("2026-08-01T09:41:00"), actor: "ai", kind: "engineering", title: "Kod yazıldı", detail: "7 dosya · +388/−74 · lint ✓ build ✓ 24 test ✓ coverage %79", cost: { usd: 2.41, model: "claude-opus-5" } },
  { at: ist("2026-08-01T09:44:00"), actor: "system", kind: "scan", title: "Güvenlik taraması", detail: "gitleaks 0 · semgrep 0 · trivy 0 · imajlar dijest-pinli" },
  { at: ist("2026-08-01T09:52:00"), actor: "ai", kind: "review", title: "Dev-reviewer: CHANGES", detail: "2 bulgu: (1) limit üst sınırı sabit kodlanmış (2) hata mesajı yerelleştirilmemiş", cost: { usd: 0.62, model: "claude-opus-5" } },
  { at: ist("2026-08-01T09:53:00"), actor: "ai", kind: "engineering", title: "Engineer oturumu #2 (resume)", detail: "Aynı oturum sürdü · 2 bulgu düzeltildi · +26/−13", cost: { usd: 0.71, model: "claude-opus-5" } },
  { at: ist("2026-08-01T10:07:00"), actor: "ai", kind: "review", title: "Dev-reviewer: APPROVE", detail: "Bulgular giderildi.", cost: { usd: 0.48, model: "claude-opus-5" } },
  { at: ist("2026-08-01T10:20:00"), actor: "ai", kind: "test_design", title: "Test senaryoları", detail: "9 senaryo (5 pozitif · 3 negatif · 1 sınır) · Gherkin", cost: { usd: 0.55, model: "claude-sonnet-5" } },
  { at: ist("2026-08-01T10:31:00"), actor: "ai", kind: "test_review", title: "Test-reviewer: APPROVE", detail: "Piramit uygun · eksik: eşzamanlı istek senaryosu eklendi.", cost: { usd: 0.22, model: "claude-sonnet-5" } },
  { at: ist("2026-08-01T13:05:00"), actor: "human", kind: "gate", title: "QA onayı — Deniz Y.", detail: "/approve · grup: qa ✓ · imza #81409" },
  { at: ist("2026-08-01T13:06:00"), actor: "ai", kind: "test_run", title: "Test-engineer oturumu", detail: "Senaryolar koda çevrildi · 27 birim + 6 entegrasyon GERÇEKTEN koştu · coverage %84 · flaky 0", cost: { usd: 0.94, model: "claude-opus-5" } },
  { at: ist("2026-08-01T13:29:00"), actor: "system", kind: "pr", title: "PR açıldı", detail: "ADO PR #1841 (draft → active) · branch feature/UGURPAY-501" },
  { at: ist("2026-08-01T13:52:00"), actor: "system", kind: "ci", title: "CI gate", detail: "ADO build validation #4821 ✓ (4dk 12sn)" },
  { at: ist("2026-08-04T16:11:00"), actor: "human", kind: "pr", title: "PR yorumu — Ayşe K.", detail: "Thread: 'limit üst sınırı konfigden okunmalı, env değil' → changes requested" },
  { at: ist("2026-08-06T14:02:00"), actor: "ai", kind: "engineering", title: "Engineer oturumu #4 (resume)", detail: "2 gün sonra aynı oturum · workspace cache'ten · klon/install atlandı · düzeltildi, thread yanıtlandı", cost: { usd: 0.79, model: "claude-opus-5" } },
];

/** Short, honest journal for the remaining runs: how it started, where it is. */
function shortJournal(ticket: DemoTicket): DemoJournalEntry[] {
  const entries: DemoJournalEntry[] = [
    {
      at: ago(ticket.ageHours),
      actor: "system",
      kind: "intake",
      title: "Ticket alındı",
      detail: `${ticket.key} webhook ile geldi · imza doğrulandı · work mode: ${ticket.mode}`,
    },
    {
      at: ago(ticket.ageHours - 0.5),
      actor: "ai",
      kind: "intake",
      title: "Intake — tamam",
      detail: "Ticket tam. Akış başlatıldı.",
      cost: { usd: 0.01, model: "claude-haiku-4-5" },
    },
  ];

  if (ticket.status === "queued") {
    entries.push({
      at: ago(ticket.idleHours),
      actor: "system",
      kind: "quota",
      title: "Abonelik kotası bekleniyor",
      detail: "Havuzdaki tüm hesaplar dolu · pencere açılınca kaldığı yerden devam edecek (M55).",
    });
  } else if (ticket.status === "fail") {
    entries.push({
      at: ago(ticket.idleHours),
      actor: "system",
      kind: "ci",
      title: "CI kırmızı",
      detail: "ADO build validation başarısız · ajan aynı oturumda düzeltiyor.",
    });
  } else if (ticket.status === "done") {
    entries.push({
      at: ago(ticket.idleHours),
      actor: "system",
      kind: "closure",
      title: "Kanıt paketi hazırlandı",
      detail: "Analiz + diff + test raporu + onay zinciri arşivlendi (M56).",
    });
  } else if (ticket.status === "gate") {
    entries.push({
      at: ago(ticket.idleHours),
      actor: "system",
      kind: "gate",
      title: `Kapı açıldı — adım ${ticket.step}`,
      detail: "Onay bekleniyor · hatırlatıcı merdiveni işletiliyor (M88).",
    });
  } else {
    entries.push({
      at: ago(ticket.idleHours),
      actor: "ai",
      kind: "engineering",
      title: `Adım ${ticket.step} çalışıyor`,
      detail: "Ajan oturumu sürüyor.",
    });
  }

  return entries;
}

const JOURNAL: Prisma.JournalEntryCreateManyInput[] = DEMO_TICKETS.flatMap((ticket) => {
  const entries =
    ticket.key === "UGURPAY-501" ? UGURPAY_501_JOURNAL : shortJournal(ticket);
  return entries.map((entry, index) => ({
    runId: demoRunId(ticket.key),
    seq: index,
    at: entry.at,
    actor: entry.actor,
    kind: entry.kind,
    title: entry.title,
    detail: entry.detail,
    // Left unset (SQL NULL) when the step cost nothing — e.g. human actions.
    ...(entry.cost === undefined
      ? {}
      : { costJson: { usd: entry.cost.usd, model: entry.cost.model } }),
  }));
});

// ---------------------------------------------------------------------------
// Audit chain (M33)
// ---------------------------------------------------------------------------

export interface AuditSeedEvent {
  at: Date;
  actor: string;
  action: AuditAction;
  subject: string;
  meta?: Record<string, unknown>;
}

/** Canonical, order-sensitive payload of one audit row. */
export function auditPayload(
  seq: number,
  event: AuditSeedEvent,
  prevHash: string,
): string {
  return [seq, event.at.toISOString(), event.actor, event.action, event.subject, prevHash].join("|");
}

/**
 * Build a verifiable hash chain over the demo events.
 *
 * NOTE (see RAPOR.md): `packages/audit` owns the single production
 * implementation of the chain (M33). This helper exists only because that
 * package does not exist yet; the seed must switch to it once it lands, and
 * the algorithm here is deliberately the obvious one (sha256 over the
 * canonical payload, `"genesis"` as the first predecessor).
 */
export function chainAuditEvents(
  events: readonly AuditSeedEvent[],
  startSeq: number,
): Prisma.AuditLogCreateManyInput[] {
  const rows: Prisma.AuditLogCreateManyInput[] = [];
  let prevHash = "genesis";
  events.forEach((event, index) => {
    const seq = startSeq + index;
    const hash = createHash("sha256").update(auditPayload(seq, event, prevHash)).digest("hex");
    rows.push({
      seq: BigInt(seq),
      at: event.at,
      actor: event.actor,
      action: event.action,
      subject: event.subject,
      prevHash,
      hash,
      metaJson: (event.meta ?? {}) as Prisma.InputJsonValue,
    });
    prevHash = hash;
  });
  return rows;
}

/** Ordered oldest → newest; the mock's audit screen shows the tail of this. */
const AUDIT_EVENTS: AuditSeedEvent[] = [
  { at: ago(48), actor: "maestro-worker", action: "RUN_STARTED", subject: "UGURDESK-45" },
  { at: ago(47), actor: "maestro-worker", action: "MODE_CHANGED", subject: "UGURWEB-95 · human_only" },
  { at: ago(30), actor: "ayse.kaya@ugurbank.local", action: "PARAM_CHANGED", subject: "gates.risk_tiers → v4" },
  { at: ago(29), actor: "ugur.yildiz@ugurbank.local", action: "BINDING_CHANGED", subject: "UGURDESK · draft → active" },
  { at: ago(24), actor: "maestro-worker", action: "GATE_OPEN", subject: "UGURWEB-72 · 9-QA senaryo onayı" },
  { at: ago(20), actor: "maestro-worker", action: "CLARIFICATION_ASKED", subject: "UGURPAY-712 · 3 soru" },
  { at: ago(12), actor: "maestro-worker", action: "ASSIGN_APP", subject: "UGURMOB-201 · ugurmobil-ios (AI %94, kapıda doğrulandı)" },
  { at: ago(8), actor: "maestro-worker", action: "PR_OPENED", subject: "UGURPAY-123 · ADO PR #1836" },
  { at: ago(5.5), actor: "system", action: "QUOTA_WARN", subject: "claude-sub-03 · 5s penceresi %80" },
  { at: ago(5.3), actor: "maestro-worker", action: "PII_MASKED", subject: "UGURDESK-52 · 2 alan maskelendi (IBAN, müşteri no)" },
  { at: ago(3), actor: "maestro-worker", action: "GATE_OPEN", subject: "UGURMOB-188 · 5-Tech Lead analiz onayı" },
  { at: ago(0.7), actor: "maestro-worker", action: "SECURITY_SCAN_PASS", subject: "UGURPAY-502 · 0 bulgu" },
  { at: ago(0.4), actor: "maestro-runner", action: "SANDBOX_DESTROY", subject: "UGURPAY-123 · lnx-01" },
  { at: ago(0.15), actor: "maestro-worker", action: "TEST_RUN_COMPLETE", subject: "UGURPAY-123 · coverage %83" },
  { at: ago(0.13), actor: "maestro-worker", action: "GATE_OPEN", subject: "UGURPAY-123 · 11-QA sonuç onayı" },
];

/** Matches the mock's counter (#81422 is the newest row). */
const AUDIT_START_SEQ = 81_408;

const AUDIT_LOG = chainAuditEvents(AUDIT_EVENTS, AUDIT_START_SEQ);

// ---------------------------------------------------------------------------
// LLM gateway, variants, subscription pool
// ---------------------------------------------------------------------------

const LLM_CALLS: Prisma.LlmCallCreateManyInput[] = [
  { at: ago(0.13), runId: demoRunId("UGURPAY-123"), role: "test_engineer", variantId: "engineer-web", driver: "anthropic-direct", model: "claude-opus-5", tokensIn: 48_200, tokensOut: 6_100, cachePct: 71, usd: "0.42", dataClass: "dahili" },
  { at: ago(0.25), runId: demoRunId("UGURPAY-504"), role: "analyst", variantId: "analyst-desktop", driver: "aws-bedrock", model: "claude-opus-5", tokensIn: 31_000, tokensOut: 4_400, cachePct: 64, usd: "0.31", dataClass: "dahili" },
  { at: ago(0.5), runId: demoRunId("UGURPAY-712"), role: "intake", variantId: "intake-default", driver: "anthropic-direct", model: "claude-haiku-4-5", tokensIn: 3_100, tokensOut: 400, cachePct: 0, usd: "0.01", dataClass: "dahili" },
  { at: ago(0.6), runId: demoRunId("UGURDESK-52"), role: "analyst", variantId: "analyst-web", driver: "openai-compat", model: "qwen3-coder-on-prem", tokensIn: 22_500, tokensOut: 3_200, cachePct: null, usd: null, dataClass: "gizli" },
  { at: ago(0.85), runId: demoRunId("UGURPAY-502"), role: "engineer", variantId: "engineer-ios", driver: "claude-sub", model: "claude-opus-5", tokensIn: 96_400, tokensOut: 12_800, cachePct: 78, usd: null, dataClass: "dahili" },
];

const VARIANT_ROWS: {
  id: string;
  role: "intake" | "analyst" | "engineer" | "dev_reviewer" | "test_designer";
  name: string;
  model: string;
  version: number;
  evalScore: number;
}[] = [
  { id: "analyst-web", role: "analyst", name: "web", model: "claude-opus-5", version: 7, evalScore: 94 },
  { id: "analyst-ios", role: "analyst", name: "mobile-ios", model: "claude-opus-5", version: 4, evalScore: 91 },
  { id: "analyst-desktop", role: "analyst", name: "desktop", model: "claude-opus-5", version: 3, evalScore: 88 },
  { id: "engineer-web", role: "engineer", name: "web", model: "claude-opus-5", version: 11, evalScore: 96 },
  { id: "engineer-ios", role: "engineer", name: "mobile-ios", model: "claude-opus-5", version: 5, evalScore: 89 },
  { id: "engineer-desktop", role: "engineer", name: "desktop", model: "claude-opus-5", version: 6, evalScore: 85 },
  { id: "reviewer-web", role: "dev_reviewer", name: "web", model: "claude-opus-5", version: 9, evalScore: 93 },
  { id: "intake-default", role: "intake", name: "default", model: "claude-haiku-4-5", version: 3, evalScore: 97 },
  { id: "testdes-web", role: "test_designer", name: "web", model: "claude-sonnet-5", version: 8, evalScore: 90 },
];

const VARIANTS: Prisma.VariantCreateManyInput[] = VARIANT_ROWS.map((v) => ({
  id: v.id,
  role: v.role,
  name: v.name,
}));

const VARIANT_VERSIONS: Prisma.VariantVersionCreateManyInput[] = VARIANT_ROWS.map((v, i) => ({
  variantId: v.id,
  version: v.version,
  model: v.model,
  configJson: { temperature: 0.2, knowledgeRefs: ["analiz-sablonu.md", "bddk-uyum.md"] },
  evalScore: v.evalScore,
  createdAt: ago(24 * (i + 3)),
}));

const SUBSCRIPTION_ACCOUNTS: Prisma.SubscriptionAccountCreateManyInput[] = [
  { accountId: "claude-sub-01", driver: "claude-sub", state: "ready", windowsJson: [{ kind: "5h", usedPct: 62, resetsAt: ago(-2).toISOString() }, { kind: "weekly", usedPct: 41, resetsAt: ago(-72).toISOString() }], lastUsedAt: ago(0.2) },
  { accountId: "claude-sub-02", driver: "claude-sub", state: "ready", windowsJson: [{ kind: "5h", usedPct: 88, resetsAt: ago(-1).toISOString() }, { kind: "weekly", usedPct: 67, resetsAt: ago(-72).toISOString() }], lastUsedAt: ago(0.4) },
  { accountId: "claude-sub-03", driver: "claude-sub", state: "exhausted", windowsJson: [{ kind: "5h", usedPct: 100, resetsAt: ago(-2.2).toISOString() }, { kind: "weekly", usedPct: 72, resetsAt: ago(-72).toISOString() }], lastUsedAt: ago(1.5) },
  { accountId: "gemini-sub-01", driver: "gemini-sub", state: "ready", windowsJson: [{ kind: "5h", usedPct: 34, resetsAt: ago(-3).toISOString() }, { kind: "weekly", usedPct: 28, resetsAt: ago(-72).toISOString() }], lastUsedAt: ago(6) },
  { accountId: "codex-sub-01", driver: "codex-sub", state: "disabled", windowsJson: [{ kind: "5h", usedPct: 0, resetsAt: ago(-4).toISOString() }, { kind: "weekly", usedPct: 12, resetsAt: ago(-72).toISOString() }], lastUsedAt: null },
];

const KNOWLEDGE_DOCS: Prisma.KnowledgeDocCreateManyInput[] = [
  { id: "analiz-sablonu", kind: "template", title: "analiz-sablonu.md", version: 3, contentRef: "knowledge/rules/analiz-sablonu.md", updatedAt: ago(72) },
  { id: "bddk-uyum", kind: "policy", title: "bddk-uyum.md", version: 2, contentRef: "knowledge/rules/bddk-uyum.md", updatedAt: ago(24 * 30) },
  { id: "api-tasarim", kind: "standard", title: "api-tasarim.md", version: 5, contentRef: "knowledge/conventions/api-tasarim.md", updatedAt: ago(24 * 8) },
  { id: "kredi-urunleri", kind: "app_intro", title: "kredi-urunleri.md", version: 4, contentRef: "knowledge/domain/kredi-urunleri.md", updatedAt: ago(24 * 14) },
  { id: "erisilebilirlik", kind: "standard", title: "erisilebilirlik.md", version: 1, contentRef: "knowledge/rules/erisilebilirlik.md", updatedAt: ago(24 * 60) },
  { id: "test-piramidi", kind: "standard", title: "test-piramidi.md", version: 3, contentRef: "knowledge/conventions/test-piramidi.md", updatedAt: ago(24 * 21) },
];

// ---------------------------------------------------------------------------
// Evidence packages (M56) — one per closed run
// ---------------------------------------------------------------------------

const EVIDENCE: Prisma.EvidencePackageRowCreateManyInput[] = DEMO_TICKETS.filter(
  (t) => t.status === "done",
).map((t) => ({
  runId: demoRunId(t.key),
  ticketKey: t.key,
  createdAt: ago(t.idleHours),
  manifestJson: {
    runId: demoRunId(t.key),
    ticketKey: t.key,
    createdAt: ago(t.idleHours).toISOString(),
    templateVersion: "v3",
    files: [
      { name: "analysis.md", sha256: "0".repeat(64), bytes: 18_432, contentType: "text/markdown" },
      { name: "diff.patch", sha256: "1".repeat(64), bytes: 42_110, contentType: "text/x-diff" },
      { name: "test-report.xml", sha256: "2".repeat(64), bytes: 9_876, contentType: "application/xml" },
    ],
    approvals: [],
    retentionYears: 10,
    objectLock: false,
  },
  storageKey: `evidence/${t.key}/package.zip`,
}));

// ---------------------------------------------------------------------------
// Users (M8)
// ---------------------------------------------------------------------------

/**
 * Local MVP users. `passwordHash` is a deliberately unmatchable placeholder:
 * the demo must never ship a working default credential. An admin sets the
 * first password out of band; AD/LDAP replaces all of this in Aşama 2.
 */
export const NO_PASSWORD_SET = "!";

const USERS: Prisma.UserCreateManyInput[] = [
  { id: "u-ugur", email: "ugur.yildiz@ugurbank.local", displayName: "Uğur Yıldız", passwordHash: NO_PASSWORD_SET, groupsJson: ["maestro-admins"], active: true },
  { id: "u-ayse", email: "ayse.kaya@ugurbank.local", displayName: "Ayşe Kaya", passwordHash: NO_PASSWORD_SET, groupsJson: ["product-owners", "tech-leads"], active: true },
  { id: "u-mert", email: "mert.demir@ugurbank.local", displayName: "Mert Demir", passwordHash: NO_PASSWORD_SET, groupsJson: ["tech-leads"], active: true },
  { id: "u-deniz", email: "deniz.yalcin@ugurbank.local", displayName: "Deniz Yalçın", passwordHash: NO_PASSWORD_SET, groupsJson: ["qa"], active: true },
  { id: "u-baran", email: "baran.tunc@ugurbank.local", displayName: "Baran Tunç", passwordHash: NO_PASSWORD_SET, groupsJson: ["developers"], active: true },
  { id: "u-can", email: "can.ozturk@ugurbank.local", displayName: "Can Öztürk", passwordHash: NO_PASSWORD_SET, groupsJson: ["product-owners"], active: true },
  { id: "u-denetim", email: "denetim@ugurbank.local", displayName: "Denetim (salt-okunur)", passwordHash: NO_PASSWORD_SET, groupsJson: ["internal-audit"], active: true },
];

// ---------------------------------------------------------------------------
// Dataset + seeder
// ---------------------------------------------------------------------------

export interface DemoDataset {
  users: Prisma.UserCreateManyInput[];
  applications: Prisma.ApplicationCreateManyInput[];
  repoCards: Prisma.RepoCardCreateManyInput[];
  bindings: Prisma.JiraProjectBindingCreateManyInput[];
  routingRules: Prisma.RoutingRuleCreateManyInput[];
  runs: Prisma.WorkflowRunCreateManyInput[];
  stepEvents: Prisma.StepEventCreateManyInput[];
  journal: Prisma.JournalEntryCreateManyInput[];
  auditLog: Prisma.AuditLogCreateManyInput[];
  llmCalls: Prisma.LlmCallCreateManyInput[];
  variants: Prisma.VariantCreateManyInput[];
  variantVersions: Prisma.VariantVersionCreateManyInput[];
  subscriptionAccounts: Prisma.SubscriptionAccountCreateManyInput[];
  knowledgeDocs: Prisma.KnowledgeDocCreateManyInput[];
  evidencePackages: Prisma.EvidencePackageRowCreateManyInput[];
}

/** The complete demo dataset. Pure and deterministic. */
export function buildDemoDataset(): DemoDataset {
  return {
    users: USERS,
    applications: APPLICATIONS,
    repoCards: REPO_CARDS,
    bindings: BINDINGS,
    routingRules: ROUTING_RULES,
    runs: RUNS,
    stepEvents: [...ENTER_STEP_EVENTS, ...GATE_STEP_EVENTS],
    journal: JOURNAL,
    auditLog: AUDIT_LOG,
    llmCalls: LLM_CALLS,
    variants: VARIANTS,
    variantVersions: VARIANT_VERSIONS,
    subscriptionAccounts: SUBSCRIPTION_ACCOUNTS,
    knowledgeDocs: KNOWLEDGE_DOCS,
    evidencePackages: EVIDENCE,
  };
}

export type SeedDemoDb = Pick<
  PrismaClient,
  | "user"
  | "application"
  | "repoCard"
  | "jiraProjectBinding"
  | "routingRule"
  | "workflowRun"
  | "stepEvent"
  | "journalEntry"
  | "auditLog"
  | "llmCall"
  | "variant"
  | "variantVersion"
  | "subscriptionAccount"
  | "knowledgeDoc"
  | "evidencePackageRow"
>;

/**
 * Insert the demo dataset. `skipDuplicates` makes it re-runnable and, more
 * importantly, keeps it from stamping on a real installation's rows.
 * Insert order follows the foreign keys.
 */
export async function seedDemo(db: SeedDemoDb): Promise<Record<string, number>> {
  const data = buildDemoDataset();
  const counts: Record<string, number> = {};

  const steps: [string, () => Promise<{ count: number }>][] = [
    ["users", () => db.user.createMany({ data: data.users, skipDuplicates: true })],
    ["applications", () => db.application.createMany({ data: data.applications, skipDuplicates: true })],
    ["repoCards", () => db.repoCard.createMany({ data: data.repoCards, skipDuplicates: true })],
    ["bindings", () => db.jiraProjectBinding.createMany({ data: data.bindings, skipDuplicates: true })],
    ["routingRules", () => db.routingRule.createMany({ data: data.routingRules, skipDuplicates: true })],
    ["runs", () => db.workflowRun.createMany({ data: data.runs, skipDuplicates: true })],
    ["stepEvents", () => db.stepEvent.createMany({ data: data.stepEvents, skipDuplicates: true })],
    ["journal", () => db.journalEntry.createMany({ data: data.journal, skipDuplicates: true })],
    ["evidencePackages", () => db.evidencePackageRow.createMany({ data: data.evidencePackages, skipDuplicates: true })],
    ["auditLog", () => db.auditLog.createMany({ data: data.auditLog, skipDuplicates: true })],
    ["llmCalls", () => db.llmCall.createMany({ data: data.llmCalls, skipDuplicates: true })],
    ["variants", () => db.variant.createMany({ data: data.variants, skipDuplicates: true })],
    ["variantVersions", () => db.variantVersion.createMany({ data: data.variantVersions, skipDuplicates: true })],
    ["subscriptionAccounts", () => db.subscriptionAccount.createMany({ data: data.subscriptionAccounts, skipDuplicates: true })],
    ["knowledgeDocs", () => db.knowledgeDoc.createMany({ data: data.knowledgeDocs, skipDuplicates: true })],
  ];

  for (const [name, run] of steps) {
    const result = await run();
    counts[name] = result.count;
  }

  return counts;
}
