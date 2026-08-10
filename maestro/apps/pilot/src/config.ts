/**
 * Pilot constants. Unlike the demo, ONE edge is real: Jira is the live Cloud
 * site https://uyildiz.atlassian.net (project OPS). ADO stays a fake server the
 * pilot starts itself; the model, PII masking and audit are real, as in demo.
 *
 * The three real values are read from the environment at boot (see env.ts):
 *   - OPENROUTER_API_KEY  (the model)
 *   - JIRA_CLOUD_API_TOKEN (the live Jira token — through a SecretPort)
 * Neither is stored here; this file carries references, ports and defaults only.
 */

/** Browser entry point. 7020 to avoid clashing with the demo's 7010. */
export const UI_PORT = 7020;
/** Fake Azure DevOps Services (the only prop server the pilot starts). */
export const ADO_PORT = 7021;

/** Secret references, in the `@maestro/secrets` key grammar. */
export const SECRET_REFS = {
  /** Live Atlassian API token — the only NON-throwaway secret in the pilot. */
  jiraCloud: "kv/jira-cloud/token#value",
  adoPat: "kv/ado/pat#value",
  adoWebhook: "kv/ado/webhook#value",
  openrouter: "kv/llm/openrouter#value",
  /** GitHub token (fine-grained PAT or App installation token) — only seeded when PILOT_SCM=github. */
  github: "kv/github/token#value",
} as const;

// ----------------------------------------------------------------- SCM switch

/**
 * Which ScmPort the pilot drives (Dalga C2). `fake` (the default) keeps the
 * existing behaviour EXACTLY — the ADO prop, no push, `issueSecret` throws — so
 * nothing changes without an explicit opt-in. `github` builds the REAL GitHub
 * driver from GITHUB_OWNER/REPO + token and does a REAL git push + PR.
 *
 * The default is deliberately `fake`: a missing GitHub token must never turn
 * into a silent no-op push, and every offline test runs the fake unless it opts
 * into github with an injected fetch + exec.
 */
export type ScmMode = "fake" | "github";

/** Reads and validates PILOT_SCM; anything but `github` is treated as `fake`. */
export function scmMode(env: Record<string, string> = {}): ScmMode {
  const raw = (process.env["PILOT_SCM"] ?? env["PILOT_SCM"] ?? "fake").trim().toLowerCase();
  return raw === "github" ? "github" : "fake";
}

/**
 * TTL requested for the short-lived push credential (M31). Well under the
 * driver's one-hour ceiling: the credential only has to survive one
 * clone→push, and a tighter window shrinks the blast radius of a leak.
 */
export const GITHUB_PUSH_TTL_SECONDS = 600;

/** Base branch the pilot's feature branch targets on GitHub. */
export const GITHUB_TARGET_BRANCH = process.env["GITHUB_TARGET_BRANCH"] ?? "main";

/**
 * Values behind the FAKE references only. The Jira Cloud token is never here —
 * it is seeded into the SecretPort from JIRA_CLOUD_API_TOKEN at boot.
 */
export const PILOT_SECRETS = {
  adoPat: "pilot-ado-pat",
  adoWebhook: "pilot-ado-service-hook-secret",
} as const;

/** Basic-auth username half of the ADO Service Hook credential. */
export const ADO_WEBHOOK_USERNAME = "maestro";

// ------------------------------------------------------------------ Jira (real)

/** Project on the live site the pilot works in. */
export const PROJECT_KEY = "OPS";

/** JQL that finds tickets opted in to Maestro. Bounded (project = …). */
export const DISCOVERY_JQL = `project = ${PROJECT_KEY} AND labels = maestro ORDER BY created DESC`;
/** Cap the discovery page — the driver's bounded-JQL guard still applies. */
export const DISCOVERY_MAX = 20;

/** Fields to fetch per discovered issue (enough to render + map). */
export const DISCOVERY_FIELDS = ["summary", "status", "labels", "created", "reporter", "issuetype"] as const;

/**
 * Group whose membership every gate approval is checked against (M32/M51).
 *
 * SoD RELAXATION (M71): the live site is single-user — the operator is PO, TL
 * and QA at once — so the gate cannot be given to a DIFFERENT person than the
 * one who started the run. The pilot relaxes SoD by pointing the approver group
 * at one the operator is genuinely in on the site (recorded in
 * fixtures/cloud/group-member-by-name.json). The rule is NOT deleted: the
 * verifyMembership check still runs and still fail-closes on a non-member.
 * See RAPOR.md. Override with PILOT_APPROVER_GROUP.
 */
export const APPROVER_GROUP = process.env["PILOT_APPROVER_GROUP"] ?? "jira-users-uyildiz";

/**
 * The audit trail records a gate approver as a corporate account (`user@corp`),
 * but a Cloud comment author is an opaque `accountId` (Cloud has no username,
 * and GDPR lets a site hide e-mails). This maps the pilot operator's accountId
 * to the corporate account the audit records — the human stays visible in the
 * chain. An author that is ALREADY e-mail-shaped is used as-is; an unknown
 * accountId falls back to PILOT_OPERATOR_ACCOUNT so a gate is never recorded
 * with an unattributable actor. Override both via env.
 */
export const PILOT_OPERATOR_ACCOUNT = process.env["PILOT_OPERATOR_ACCOUNT"] ?? "0uguryldz94@gmail.com";

/**
 * Corporate account for a Cloud comment author (audit needs `user@corp`).
 *
 * The operator-account fallback is passed in so this can be resolved against the
 * live SettingsStore at USE time (the UI can change it without a restart). An
 * author that is already e-mail-shaped is used as-is regardless.
 */
export function corpAccountOf(author: string, operatorAccount: string = PILOT_OPERATOR_ACCOUNT): string {
  const value = author.trim();
  if (/^[^@\s]+@[^@\s]+$/.test(value)) return value; // already an e-mail identity
  return operatorAccount; // opaque accountId → configured operator account
}

// ------------------------------------------------------------------ ADO (fake)

export const ADO_ORG = "ugurbank";
export const ADO_PROJECT = "UgurPay";
export const ADO_REPO = "ugurpay";
/** The one build definition allowed to close the CI gate (M12 allow-list). */
export const ADO_PR_VALIDATION_DEFINITION = 12;

/** Model used for every thinking role. Cheap on purpose (same as demo). */
export const PILOT_MODEL = process.env["PILOT_MODEL"] ?? "openai/gpt-4o-mini";

/** Variant id recorded on every gateway call log (M38). */
export const PILOT_VARIANT = "pilot-v1";

/**
 * Data class of the payloads. `gizli` + `onPremMissing: "masked_cloud"` masks
 * before anything leaves the machine — the bank's real posture (M18/M63).
 * Overridable (UI-editable) via PILOT_DATA_CLASS; defaults to `gizli`.
 */
export const PILOT_DATA_CLASS = process.env["PILOT_DATA_CLASS"] ?? "gizli";

/** How often the poller lists comments while a gate is open (ms). */
export const COMMAND_POLL_MS = Number(process.env["PILOT_COMMAND_POLL_MS"] ?? 3_000);
/** How often discovery re-lists opted-in tickets while idle (ms). */
export const DISCOVERY_POLL_MS = Number(process.env["PILOT_DISCOVERY_POLL_MS"] ?? 15_000);

/**
 * The seed for the runtime `SettingsStore` — the six UI-editable settings, read
 * ONCE from the env constants above. After boot the store is authoritative; the
 * env only seeds it, so nothing changes if the panel is never touched. Structural
 * constants (ADO_*, ports, JQL) and secrets are deliberately NOT here.
 */
export function defaultSettings(): {
  approverGroup: string;
  model: string;
  commandPollMs: number;
  discoveryPollMs: number;
  dataClass: string;
  operatorAccount: string;
} {
  return {
    approverGroup: APPROVER_GROUP,
    model: PILOT_MODEL,
    commandPollMs: COMMAND_POLL_MS,
    discoveryPollMs: DISCOVERY_POLL_MS,
    dataClass: PILOT_DATA_CLASS,
    operatorAccount: PILOT_OPERATOR_ACCOUNT,
  };
}
