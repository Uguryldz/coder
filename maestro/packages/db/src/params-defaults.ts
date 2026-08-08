import type { ParamDefinition } from "@maestro/contracts";

/**
 * Default operational parameters (M71): every knob the Studio "Parametreler"
 * screen shows lives in the database, versioned and audited — `.maestro.yaml`
 * keeps only repo-native facts (build/test commands, protected_paths).
 *
 * The set is the mock's parameters screen (12 rows) plus five knobs that an
 * M-decision requires but the mock screen did not list. `test/seed.test.ts`
 * checks the seed against both sources, so a missing knob fails a test rather
 * than being discovered when a service reaches for it.
 *
 * Rules followed by every entry below:
 *  · `descriptionKey` is an i18n key under `params.description.*` (M104) —
 *    no user-facing text is ever stored in the database.
 *  · `guarded: true` means a change needs a second approver (4-eyes); the flag
 *    follows the mock's "4-göz" badge, and anything that can weaken a control
 *    carries it.
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
    // M48a/M102 — how a project's tickets enter the flow. Default is the
    // opt-in label: a freshly bound project must not start swallowing every
    // ticket the moment the binding goes active.
    key: "trigger.mode",
    scope: "project",
    type: "enum",
    guarded: false,
    enumValues: ["auto", "label", "command"],
    descriptionKey: "params.description.trigger_mode",
    defaultValue: "label",
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
    // M54 — stuck protection: three rejections at the same gate OR three
    // identical CI failures hand the work to a human in ai_assist, with the
    // whole journal. N is a parameter precisely because 3 is a guess.
    key: "stuck.threshold",
    scope: "global",
    type: "json",
    guarded: false,
    descriptionKey: "params.description.stuck_threshold",
    defaultValue: { gateRejections: 3, ciFailures: 3, action: "handover_ai_assist" },
  },
  {
    // M19 — quota/budget warning threshold. 100% stops; this is the shout
    // before the stop, so an operator can top up the pool in time (M55).
    key: "quota.warn_pct",
    scope: "global",
    type: "number",
    guarded: false,
    descriptionKey: "params.description.quota_warn_pct",
    defaultValue: 80,
  },
  {
    // M85 — how long a build may take before the run re-queues it once. Keyed
    // by PlatformProfile, because a macOS Xcode build is not a Node build.
    key: "build.timeout_min",
    scope: "global",
    type: "json",
    guarded: false,
    descriptionKey: "params.description.build_timeout_min",
    defaultValue: {
      byPlatform: {
        "linux-node": 30,
        "linux-android": 30,
        "macos-xcode": 60,
        "windows-dotnet": 45,
      },
      autoRequeueCount: 1,
    },
  },
  {
    // M27 — lowest scan severity that stops the flow; anything below is listed
    // as a PR note. Guarded: raising it is how a team stops being blocked by
    // its own findings.
    key: "scan.block_level",
    scope: "global",
    type: "enum",
    guarded: true,
    enumValues: ["info", "low", "medium", "high", "critical"],
    descriptionKey: "params.description.scan_block_level",
    defaultValue: "high",
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

/** Definition lookup; `undefined` for an unknown key (the caller fails closed). */
export function findParamDefinition(key: string): ParamDefinition | undefined {
  return DEFAULT_PARAM_DEFINITIONS.find((definition) => definition.key === key);
}
