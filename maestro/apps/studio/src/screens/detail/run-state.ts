import type { JournalKind, StepId, WorkflowRunState, WorkflowRunStatus } from "@maestro/contracts";

/**
 * The statuses that mean "this run is over" — the same set the BFF's
 * reconciler treats as final (`TERMINAL`, routes/studio-runs.ts) and the
 * run-context store enforces on the database side.
 *
 * Load-bearing for the sidebar: a finished run has NO engine execution by
 * design, so "the engine does not know this run" is its normal state, not a
 * fault — and the restart panel, the gate panel and the mode control all
 * belong only to a run that is still going.
 */
const TERMINAL: readonly WorkflowRunStatus[] = ["fail", "done", "cancelled"];

export function isTerminal(state: Pick<WorkflowRunState, "status"> | null): boolean {
  return state !== null && TERMINAL.includes(state.status);
}

/** Spend in the viewer's locale — "US$2,25" in tr, "$2.25" in en. */
export function moneyLabel(usd: number, locale: string): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(usd);
}

/**
 * One error line the run recorded about itself, as `GET /studio/runs/:ticket`
 * sends it (`RunFailure`, apps/bff/src/routes/studio-runs.ts). The BFF derives
 * it from the journal — the run row has no error column and the engine's own
 * failure record never reaches the BFF — so this is the activity's LAST WORDS
 * before it died, attributed to the step that was current when it spoke.
 *
 * `step` is `null` when the line predates the workflow's first transition; the
 * screen then hangs the note under the run's own step.
 */
export interface RunFailure {
  readonly step: StepId | null;
  readonly kind: JournalKind;
  readonly title: string;
  readonly detail: string;
  readonly at: string;
  readonly seq: number;
}

/**
 * The error fields of the detail body. Both OPTIONAL on the wire: a BFF that
 * predates them sends neither, and that must read as "no error text on
 * record", not as a crash on `recentErrors.map`.
 */
export interface RunErrorFields {
  readonly failure?: RunFailure | null;
  readonly recentErrors?: readonly RunFailure[];
}

/**
 * The error lines a detail body carries, newest first — `[]` when it carries
 * none. Takes the body as `object` and narrows at runtime, because the fields
 * are optional on the wire and `RunDetail` (shared/runs.ts) does not declare
 * them: this is the one place that knows what an older BFF's answer means.
 */
export function recentErrorsOf(detail: object): readonly RunFailure[] {
  const fields = detail as RunErrorFields;
  if (Array.isArray(fields.recentErrors)) return fields.recentErrors;
  return fields.failure === null || fields.failure === undefined ? [] : [fields.failure];
}
