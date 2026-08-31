import {
  EMPTY_STATUS_DRAFT,
  type StatusDraft,
} from "../common/status-map.ts";

/**
 * The guided setup's data model — everything the five panes read and write,
 * plus the one piece of real logic the wizard owns: which defaults a chosen
 * flow type implies.
 *
 * Kept out of the screen component so the defaults can be asserted directly and
 * so the panes stay presentational. The wizard is deliberately a SINGLE draft
 * object rather than per-step state: "geri gidince yazdıklarım kayboldu" is the
 * complaint that makes a wizard worse than the three tabs it replaces, and one
 * object that never resets on navigation is the cheapest way to make that
 * impossible rather than merely unlikely.
 */

/** The three flows Maestro can run. There is no fourth. */
export const FLOW_TYPES = ["analiz", "duzeltme", "gelistirme"] as const;
export type FlowType = (typeof FLOW_TYPES)[number];

/**
 * Which flows touch a repository — and therefore need a repository connection
 * before the wizard may offer them.
 *
 * `analiz` produces a document and stops, so it works on an install that has
 * never heard of GitHub. The other two write code and open a pull request; a
 * run that reaches those steps with no SCM connection cannot finish.
 *
 * This exists because the failure it prevents was expensive and silent. The
 * radio group offered all three unconditionally, an operator picked "Yeni özellik
 * geliştirme", the rule saved, the ticket ran — intake, analysis, publication,
 * a human's approval — and only then did the engineering step fail. Every one
 * of those steps cost real time, and the thing that made them futile was
 * knowable before the first click.
 *
 * The check is a PREREQUISITE, not a capability flag: it asks whether this
 * install has been given a repository, which an operator can fix in the panel
 * and see reflected here immediately. It is deliberately NOT a question about
 * the server's profile — that was the old answer, and it was unfixable from
 * the UI by design.
 */
export function flowNeedsRepository(flow: FlowType): boolean {
  return flow !== "analiz";
}

/**
 * Whether this draft binds NO repository — the analysis-only, ticket-text
 * mode. One predicate, read by the summary, the save mutation and the panes,
 * so the sentence the operator signs off on and the request the wizard sends
 * cannot disagree about which mode the binding is in.
 *
 * Only `analiz` can be repo-less (the other two flows are blocked at step 2
 * without one), and an `analiz` draft whose operator DID pick a repo stays in
 * repo mode: the optional offer is "bağlarsanız etki analizi dosyalara
 * bakarak yazılır", and picking one is accepting it.
 */
export function bindsNoRepository(draft: SetupDraft): boolean {
  return draft.flowType === "analiz" && draft.repoFullName === "";
}

/**
 * Why a flow cannot be offered right now, as a catalog key — or `null` when it
 * can.
 *
 * `scmConnectionCount` is `null` while the list is still loading. Unknown is
 * NOT the same as zero: accusing an install of having no repository because a
 * request has not come back yet would send an operator to Ayarlar for nothing,
 * which is the same lie the prerequisite banner already takes care to avoid.
 */
export function flowUnavailableReason(
  flow: FlowType,
  scmConnectionCount: number | null,
): string | null {
  if (!flowNeedsRepository(flow)) return null;
  if (scmConnectionCount === null) return null;
  return scmConnectionCount === 0 ? "setup.flow.needs_scm" : null;
}

/**
 * Which ticket field the rule matches on — the wizard's TETİKLEME TİPİ. Mirrors
 * the BFF's `MATCH_KINDS` and the DB CHECK (migrations 0020, 0023).
 *
 * `assigned` is the third answer the wizard could not give: "her ticket" — no
 * type, no status, just the fact that a human assigned it to the Maestro bot.
 * It is the trigger most first-time operators actually want, and forcing them
 * to name an issue type instead is how a project ends up listening to a type
 * nobody uses.
 *
 * `label` (0023) is the fourth. It used to be a PROJECT-level setting the
 * wizard asked about separately ("tetikleme etiketi"), which meant one screen
 * asked what triggers a run and another screen also did, with neither knowing
 * about the other. Now the question is asked exactly once, here.
 */
export type MatchKind = "status" | "issuetype" | "assigned" | "label";

/**
 * The value an `assigned` rule sends. The BFF pins it to the same literal
 * anyway (the unique trigger index needs one), so this is the wizard agreeing
 * with the server rather than the wizard deciding — it is never shown to an
 * operator and never compared to a ticket.
 */
export const ASSIGNED_MATCH_VALUE = "*";

/**
 * The data classes a binding can carry — `DataClassE` in the Prisma schema
 * (M18), most open first. There is no fourth.
 */
export const DATA_CLASSES = ["acik", "dahili", "gizli"] as const;
export type DataClass = (typeof DATA_CLASSES)[number];

/**
 * How the commands written on a ticket reach Maestro (`jira.command_intake`).
 *
 * `/approve` and `/reject <sebep>` arrive as ticket comments, and there are
 * exactly two ways to read one: Jira calls us (the webhook), or we ask Jira
 * (the poller). They are ALTERNATIVES, not a checklist — which is why this is
 * one question with three answers rather than two independent switches.
 */
export const COMMAND_INTAKES = ["webhook", "poll", "both"] as const;
export type CommandIntake = (typeof COMMAND_INTAKES)[number];

/** Whether this answer makes Maestro poll Jira at an interval. */
export function intakePolls(intake: CommandIntake): boolean {
  return intake !== "webhook";
}

/**
 * The interval offered when an operator first turns polling on, in seconds.
 *
 * Mirrors `jira.poll_seconds`'s seeded default. A minute is the compromise the
 * parameter's comment argues for: a command is a person waiting at their desk,
 * so a five-minute wait reads as the platform being broken — and reading the
 * comments of the handful of tickets with an OPEN run is not what makes a Jira
 * instance slow.
 */
export const DEFAULT_POLL_SECONDS = 60;

/**
 * The bounds the wizard accepts for the interval.
 *
 * A floor because 1 second is not a setting, it is an outage: this loop reads
 * every open ticket's comment thread each round, and a bank's Jira is shared
 * with everyone else in the bank. A ceiling because an interval measured in
 * hours silently turns the answer "biz Jira'ya soralım" back into the failure
 * it was meant to fix — a gate nobody can close in a working day.
 */
export const MIN_POLL_SECONDS = 15;
export const MAX_POLL_SECONDS = 3600;

/**
 * Why this intake cannot be offered on this install — as a catalog key, or
 * `null` when it can.
 *
 * `canReadComments` is `undefined` while the capability is still unknown (the
 * request is in flight, or it failed), and unknown is NOT the same as "cannot":
 * the same rule `flowUnavailableReason` follows. Telling an operator their Jira
 * driver cannot poll because a status endpoint has not answered yet would push
 * them onto the webhook — the one path that was already failing when they came
 * to this screen.
 *
 * The answer is shown BESIDE the option and blocks "İleri" rather than hiding
 * the choice. A silently missing option answers "why can't I poll?" with
 * nothing, and an operator who cannot see the answer they were told to pick
 * files a support ticket instead.
 */
export function intakeUnavailableReason(
  intake: CommandIntake,
  canReadComments: boolean | undefined,
): string | null {
  if (!intakePolls(intake)) return null;
  if (canReadComments === undefined) return null;
  return canReadComments ? null : "setup.intake.no_reader";
}

/**
 * Whether step 5's answer differs from what the platform already holds — and
 * therefore whether saving should write the parameters at all.
 *
 * The wizard is per-project and this setting is global. An operator adding
 * their fourth project must not mint a new parameter version, and a new audit
 * row, for a value they never touched — which is what an unconditional write
 * would do on every run.
 *
 * An UNKNOWN current state (the read failed, or the endpoint is not there)
 * counts as changed: the operator answered the question, and the only honest
 * response to "I could not read what is in force" is to write what they said.
 * Silently dropping the answer is the failure this whole step exists to end.
 *
 * The interval is only compared when the answer polls. A webhook-only draft
 * carries whatever number the field last held, and treating that as a change
 * would write a parameter version on a wizard run that changed nothing.
 */
export function intakeChanged(
  draft: Pick<SetupDraft, "commandIntake" | "pollSeconds">,
  current: { readonly mode: CommandIntake; readonly pollSeconds: number } | undefined,
): boolean {
  if (current === undefined) return true;
  if (current.mode !== draft.commandIntake) return true;
  return intakePolls(draft.commandIntake) && current.pollSeconds !== draft.pollSeconds;
}

/** The six panes, in the order an operator walks them. */
export const SETUP_STEPS = ["flow", "project", "tickets", "status", "intake", "review"] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

export interface SetupDraft {
  /** Step 1 — chosen first, because it decides the defaults for everything else. */
  readonly flowType: FlowType;
  /** Step 2 — the Jira connection the project is listed from, and the project. */
  readonly jiraConnectionId: string;
  readonly jiraProject: string;
  /** Step 2 — the SCM connection and the repository the work lands in. */
  readonly connectionId: string;
  readonly repoFullName: string;
  readonly platform: string;
  /**
   * Step 2 — how confidential this application's tickets are (M18).
   *
   * Asked rather than assumed because the assumption was wrong in the one way
   * the operator could not see. The binding used to fail closed to `gizli`, and
   * `packages/llm-gateway/src/policy.ts` refuses — correctly, on-prem only, no
   * exceptions — to send `gizli` content to a cloud model. On a deployment with
   * no on-prem model that is not a safe default, it is a SILENT one: the run
   * degraded to `ai_assist` and told the operator "modeli kullanamadım, elle
   * tamamlayın" with nothing anywhere naming the data class as the cause.
   * (Measured: SAM1-12 stalled; after SAM1 was moved to `dahili`, SAM1-13 ran
   * analysis normally.) A question with the CONSEQUENCE written next to each
   * answer is the only honest version of this field.
   */
  readonly dataClass: DataClass;
  /** Step 3 — which tickets the rule picks up. */
  readonly assigneeAccountId: string;
  readonly matchKind: MatchKind;
  readonly matchValue: string;
  /** Step 4 — the optional Jira status map, OFF unless the operator turns it on. */
  readonly statusOn: boolean;
  readonly statusDraft: StatusDraft;
  readonly reassignOnNeedInfo: boolean;
  /**
   * Step 5 — how `/approve` reaches Maestro (`jira.command_intake`).
   *
   * The one PLATFORM-WIDE answer in an otherwise per-project draft, and the
   * wizard says so on the pane: it is written to the global parameter, so an
   * operator running the wizard a second time for a second project is changing
   * a setting the first project shares. Asked here anyway, because this is the
   * screen a first-time operator sees and the setting decides whether the
   * approval they are about to configure can ever be given from the ticket.
   */
  readonly commandIntake: CommandIntake;
  /** Step 5 — the polling interval in SECONDS; ignored for webhook-only. */
  readonly pollSeconds: number;
}

/**
 * The starting draft. `analiz` leads because it is the only flow that cannot
 * write code: a first-time operator who clicks straight through ends up with
 * the most conservative configuration this wizard can produce, not the one that
 * opens pull requests against a bank's repository.
 */
export const EMPTY_SETUP_DRAFT: SetupDraft = {
  flowType: "analiz",
  jiraConnectionId: "",
  jiraProject: "",
  connectionId: "",
  repoFullName: "",
  platform: "",
  // `dahili` is the safe-but-WORKABLE default. `gizli` is safer on paper and is
  // what the server used to assume, but on an install with no on-prem model it
  // silently disables analysis altogether — a default that stops the product
  // from working is not a conservative default, it is a broken one. `acik`
  // would be the genuinely permissive choice and is never a default.
  dataClass: "dahili",
  assigneeAccountId: "",
  matchKind: "issuetype",
  matchValue: "",
  statusOn: false,
  statusDraft: EMPTY_STATUS_DRAFT,
  reassignOnNeedInfo: false,
  // The starting answer is what the platform ALREADY does, not what the wizard
  // recommends: the screen overwrites both fields with the stored parameters
  // once they load, and a draft that started on "poll" would show an operator
  // their webhook-only install as though it polled. `webhook` is also the
  // seeded default, so the two agree on a fresh install.
  commandIntake: "webhook",
  pollSeconds: DEFAULT_POLL_SECONDS,
};

/**
 * What the chosen flow implies for the binding it proposes.
 *
 * This is the wizard's whole reason to ask "ne yapmak istiyorsun?" first. The
 * expert screen makes an operator answer trigger/gate/merge as three separate
 * questions in vocabulary ("risk_tiered", "opt_in") that means nothing to
 * someone whose job is approving Jira tickets. Here the same three answers fall
 * out of the one question they CAN answer, and the summary pane spells the
 * result back to them in sentences.
 *
 * `analiz` never merges anything, so its merge mode is moot — human is still
 * what is sent, because a flow that writes no code must not be the one binding
 * that says "auto" if the flow is later changed on the expert screen.
 */
export interface FlowDefaults {
  readonly triggerMode: "opt_in" | "automatic";
  readonly gateSet: "risk_tiered" | "always_six";
  readonly mergeMode: "human" | "auto";
}

const FLOW_DEFAULTS: Readonly<Record<FlowType, FlowDefaults>> = {
  // Analysis produces a document and stops. Nothing it does can reach a repo,
  // so the lightest gate set is honest rather than lax.
  analiz: { triggerMode: "opt_in", gateSet: "risk_tiered", mergeMode: "human" },
  // A bug fix DOES write code, and it skips the analysis gate to get there.
  // Opt-in triggering is what keeps that from happening to a ticket nobody
  // pointed at Maestro.
  duzeltme: { triggerMode: "opt_in", gateSet: "risk_tiered", mergeMode: "human" },
  // Feature work walks the full ladder. Every gate, every time: this is the
  // flow that opens the largest pull requests, and it is not the place to start
  // trimming checks on a first-time setup.
  gelistirme: { triggerMode: "opt_in", gateSet: "always_six", mergeMode: "human" },
};

export function flowDefaults(flow: FlowType): FlowDefaults {
  return FLOW_DEFAULTS[flow];
}

/**
 * Whether a step has everything it needs to move on, and — when it does not —
 * WHICH catalog key explains why in the operator's own terms.
 *
 * Returning the reason rather than a boolean is the point. "İleri" going dead
 * with no explanation is the failure mode of every wizard a bank has already
 * suffered through; every blocked step here can say which field is empty or
 * which prerequisite is missing, and the caller renders it next to the button.
 */
export function stepBlockedReason(
  step: SetupStep,
  draft: SetupDraft,
  scmConnectionCount: number | null = null,
  /**
   * Whether the configured work driver can read a comment thread at all —
   * `undefined` while that is still unknown. Mirrors the BFF's
   * `canReadComments`; see `intakeUnavailableReason`.
   */
  canReadComments: boolean | undefined = undefined,
): string | null {
  switch (step) {
    case "flow":
      // A radio group with a default selected can never be EMPTY — but it can
      // hold a choice this install cannot serve. `analiz` is always available,
      // so an operator is never stranded here with nothing to pick; what they
      // are stopped from doing is walking four more steps toward a run that
      // was going to fail after a human had already approved its analysis.
      return flowUnavailableReason(draft.flowType, scmConnectionCount);
    case "project":
      if (draft.jiraConnectionId === "") return "setup.blocked.no_jira_connection_picked";
      if (draft.jiraProject === "") return "setup.blocked.no_project";
      // The repository trio is required exactly when the chosen flow will
      // write code. `analiz` produces a document from the ticket text, so an
      // analysis team without a repository — the actual first-pilot audience —
      // walks through with everything blank; a repo they DID start picking
      // must still be finished, because "half a repository" is not a binding
      // either mode can honour.
      if (!flowNeedsRepository(draft.flowType)) {
        if (draft.connectionId !== "" && draft.repoFullName === "") return "setup.blocked.no_repo";
        if (draft.repoFullName !== "" && draft.platform === "") return "setup.blocked.no_platform";
        return null;
      }
      if (draft.connectionId === "") return "setup.blocked.no_scm_connection_picked";
      if (draft.repoFullName === "") return "setup.blocked.no_repo";
      if (draft.platform === "") return "setup.blocked.no_platform";
      return null;
    case "tickets":
      if (draft.assigneeAccountId.trim() === "") return "setup.blocked.no_assignee";
      // "Bota atanan her ticket" has no second condition to fill in — the
      // assignee above IS the whole rule — so demanding a value here would make
      // the third choice impossible to get past.
      if (draft.matchKind !== "assigned" && draft.matchValue.trim() === "") {
        return "setup.blocked.no_match_value";
      }
      return null;
    case "status":
      // The whole step is optional; an operator who turned the map ON and then
      // filled nothing in is not blocked — `buildStatusMap` folds that back to
      // comment-only, which is exactly what the summary will say.
      return null;
    case "intake": {
      // A driver that cannot read a comment thread cannot poll for commands.
      // Named rather than hidden, and it stops "İleri" — accepting the answer
      // and then not polling is the silent failure this whole step exists to
      // end.
      const unavailable = intakeUnavailableReason(draft.commandIntake, canReadComments);
      if (unavailable !== null) return unavailable;
      // The interval only has to be sane when it is going to be USED. A
      // webhook-only install carries whatever number the field last held, and
      // must not be blocked by a value nothing will read.
      if (intakePolls(draft.commandIntake)) {
        if (!Number.isFinite(draft.pollSeconds) || draft.pollSeconds < MIN_POLL_SECONDS) {
          return "setup.blocked.poll_too_fast";
        }
        if (draft.pollSeconds > MAX_POLL_SECONDS) return "setup.blocked.poll_too_slow";
      }
      return null;
    }
    case "review":
      return null;
  }
}
