import type { Prisma, PrismaClient } from "@prisma/client";
import type { ParamDefinition } from "@maestro/contracts";

/**
 * Default operational parameters (M71): every knob the Studio "Parametreler"
 * screen shows lives in the database, versioned and audited — `.maestro.yaml`
 * keeps only repo-native facts (build/test commands, protected_paths).
 *
 * Rules followed by every entry below:
 *  · `descriptionKey` is an i18n key under `params.description.*` (M104) —
 *    no user-facing text is ever stored in the database.
 *  · `guarded: true` means a change needs a second approver (4-eyes). It is
 *    set for anything that can weaken a control: gate sets, merge mode,
 *    coverage floor, SoD, kill switch, data-class routing.
 *  · `defaultValue` is the safe/conservative option, so a fresh install runs
 *    with maximum supervision and is loosened deliberately.
 *
 * This array is intentionally literal (not derived from contract constants):
 * the seed is a *stored decision*, and `test/seed.test.ts` asserts it still
 * matches the contract definitions, turning any drift into a failing test
 * instead of a silent re-seed.
 */
export const DEFAULT_PARAM_DEFINITIONS: readonly ParamDefinition[] = [
  {
    // M51 — risk-tiered gate sets; the analysis picks the tier, PO may raise it.
    key: "gates.risk_tiers",
    scope: "global",
    type: "json",
    guarded: true,
    descriptionKey: "params.description.gate_set",
    defaultValue: {
      dusuk: ["5", "12"],
      orta: ["4", "5", "11", "12"],
      kritik: ["4", "5", "9", "11", "12"],
    },
  },
  {
    // M88 — reminder ladder; steps, channels and the working-day calendar are
    // all editable from Studio. Default is the plain 24h → 72h → 7d ladder.
    key: "escalation.ladder",
    scope: "global",
    type: "json",
    guarded: false,
    descriptionKey: "params.description.escalation_ladder",
    defaultValue: {
      steps: [
        { afterHours: 24, channel: "jira", event: "gate_reminder" },
        { afterHours: 72, channel: "teams", event: "escalation" },
        { afterHours: 168, channel: "smtp", event: "escalation" },
      ],
      businessHoursOnly: false,
    },
  },
  {
    // M59/M104 — AI output language. Code, commits, PR titles and test names
    // stay English regardless of this value; that is not configurable.
    key: "lang.output",
    scope: "project",
    type: "enum",
    guarded: false,
    enumValues: ["tr", "en"],
    descriptionKey: "params.description.output_language",
    defaultValue: "tr",
  },
  {
    // M70 — coverage ratchet: no fixed threshold, coverage may never drop and
    // new lines carry their own floor.
    key: "coverage.ratchet",
    scope: "application",
    type: "json",
    guarded: true,
    descriptionKey: "params.description.coverage_ratchet",
    defaultValue: { allowDecrease: false, minNewLinePct: 80 },
  },
  {
    // M92 — QA separation of duties (scenario approver ≠ result approver).
    // Ships OFF; audit turns it on when the org requires it.
    key: "sod.qa_split",
    scope: "global",
    type: "boolean",
    guarded: true,
    descriptionKey: "params.description.sod_qa_split",
    defaultValue: false,
  },
  {
    // M65 — idle workspaces are deleted from disk after 60 days; session and
    // journal survive in the StoragePort archive, so a return only costs a
    // bootstrap, never context.
    key: "workspace.max_age_days",
    scope: "global",
    type: "number",
    guarded: false,
    descriptionKey: "params.description.workspace_max_age_days",
    defaultValue: 60,
  },
  {
    // M58 — two-level kill switch. "off" = normal, "intake_only" = accept no
    // new work, "all" = stop everything (sandboxes shut down, gates keep
    // waiting). Guarded: switching back on is a control decision.
    key: "killswitch.state",
    scope: "global",
    type: "enum",
    guarded: true,
    enumValues: ["off", "intake_only", "all"],
    descriptionKey: "params.description.kill_switch_state",
    defaultValue: "off",
  },
  {
    // M48 — merge mode per project. Default is human merge; auto merge is a
    // deliberate, four-eyes decision.
    key: "merge.mode",
    scope: "project",
    type: "enum",
    guarded: true,
    enumValues: ["human_merge", "auto_merge"],
    descriptionKey: "params.description.merge_mode",
    defaultValue: "human_merge",
  },
  {
    // M102 — a binding cannot be activated before a dry run over the last N
    // tickets; N is this parameter (mirrors JiraProjectBinding.dryRunSampleSize).
    key: "binding.dry_run_sample_size",
    scope: "project",
    type: "number",
    guarded: false,
    descriptionKey: "params.description.dry_run_sample_size",
    defaultValue: 20,
  },
  {
    // M18/M63 — data-class → backend routing plus the "no on-prem GPU yet"
    // fallback for the `gizli` class. Filled in with the compliance team at
    // install time; default degrades to ai-assist rather than sending
    // confidential material to a cloud model.
    key: "dataclass.policy",
    scope: "global",
    type: "json",
    guarded: true,
    descriptionKey: "params.description.data_class_policy",
    defaultValue: {
      backendByClass: { acik: "api", dahili: "api", gizli: "onprem" },
      whenOnpremMissing: "degrade_ai_assist", // degrade_ai_assist | block | masked_cloud
    },
  },
  {
    // M55 — when every subscription account in the pool is out of quota, the
    // run waits for the next window instead of failing.
    key: "subscription.queue_enabled",
    scope: "global",
    type: "boolean",
    guarded: false,
    descriptionKey: "params.description.subscription_queue",
    defaultValue: true,
  },
  {
    // M45 — channel used for the first reminder step. Jira keeps the whole
    // conversation on the ticket, so it is the default.
    key: "notify.reminder_channel",
    scope: "global",
    type: "enum",
    guarded: false,
    enumValues: ["teams", "smtp", "jira", "slack"],
    descriptionKey: "params.description.reminder_channel",
    defaultValue: "jira",
  },
];

/** Actor recorded on the version-1 rows written by the installer. */
export const SEED_ACTOR = "installer";

/** Scope reference used for rows that are not bound to a project/app yet. */
export const GLOBAL_SCOPE_REF = "";

export interface SeedParamsOptions {
  /** Recorded as `changedBy` on the initial version rows. */
  changedBy?: string;
  /** Injected clock — keeps seeding deterministic in tests. */
  now?: Date;
}

export interface SeedParamsResult {
  definitions: number;
  initialVersions: number;
}

/**
 * Idempotent seed. Definitions are upserted (they are code-owned and may gain
 * new enum options), while version 1 is only ever *created*: if an operator
 * has already edited a parameter, re-running the seed must not walk their
 * value back.
 */
export async function seedParams(
  db: Pick<PrismaClient, "param" | "paramVersion">,
  options: SeedParamsOptions = {},
): Promise<SeedParamsResult> {
  const changedBy = options.changedBy ?? SEED_ACTOR;
  const at = options.now ?? new Date();

  for (const def of DEFAULT_PARAM_DEFINITIONS) {
    const defJson = {
      enumValues: def.enumValues ?? null,
      descriptionKey: def.descriptionKey,
      defaultValue: def.defaultValue,
    } as Prisma.InputJsonValue;

    await db.param.upsert({
      where: { key: def.key },
      create: {
        key: def.key,
        scope: def.scope,
        type: def.type,
        guarded: def.guarded,
        defJson,
      },
      update: {
        scope: def.scope,
        type: def.type,
        guarded: def.guarded,
        defJson,
      },
    });

    await db.paramVersion.upsert({
      where: {
        key_scopeRef_version: { key: def.key, scopeRef: GLOBAL_SCOPE_REF, version: 1 },
      },
      create: {
        key: def.key,
        scopeRef: GLOBAL_SCOPE_REF,
        version: 1,
        valueJson: def.defaultValue as Prisma.InputJsonValue,
        changedBy,
        approvedBy: null,
        at,
      },
      update: {}, // never overwrite an operator's value
    });
  }

  return {
    definitions: DEFAULT_PARAM_DEFINITIONS.length,
    initialVersions: DEFAULT_PARAM_DEFINITIONS.length,
  };
}
