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

export type MatchKind = "status" | "issuetype";

/** The five panes, in the order an operator walks them. */
export const SETUP_STEPS = ["flow", "project", "tickets", "status", "review"] as const;
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
  /** Step 3 — which tickets the rule picks up. */
  readonly assigneeAccountId: string;
  readonly matchKind: MatchKind;
  readonly matchValue: string;
  /** Step 4 — the optional Jira status map, OFF unless the operator turns it on. */
  readonly statusOn: boolean;
  readonly statusDraft: StatusDraft;
  readonly reassignOnNeedInfo: boolean;
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
  assigneeAccountId: "",
  matchKind: "issuetype",
  matchValue: "",
  statusOn: false,
  statusDraft: EMPTY_STATUS_DRAFT,
  reassignOnNeedInfo: false,
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
export function stepBlockedReason(step: SetupStep, draft: SetupDraft): string | null {
  switch (step) {
    case "flow":
      // A radio group with a default selected can never be empty.
      return null;
    case "project":
      if (draft.jiraConnectionId === "") return "setup.blocked.no_jira_connection_picked";
      if (draft.jiraProject === "") return "setup.blocked.no_project";
      if (draft.connectionId === "") return "setup.blocked.no_scm_connection_picked";
      if (draft.repoFullName === "") return "setup.blocked.no_repo";
      if (draft.platform === "") return "setup.blocked.no_platform";
      return null;
    case "tickets":
      if (draft.assigneeAccountId.trim() === "") return "setup.blocked.no_assignee";
      if (draft.matchValue.trim() === "") return "setup.blocked.no_match_value";
      return null;
    case "status":
      // The whole step is optional; an operator who turned the map ON and then
      // filled nothing in is not blocked — `buildStatusMap` folds that back to
      // comment-only, which is exactly what the summary will say.
      return null;
    case "review":
      return null;
  }
}
