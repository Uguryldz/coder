import type { WorkflowRunState, WorkflowRunStatus } from "@maestro/contracts";

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
