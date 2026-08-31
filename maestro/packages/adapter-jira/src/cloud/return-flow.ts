import {
  foldStatusName,
  parseAvailableTransitions,
  requireTransitionId,
  selectTransitionByStatusName,
  type AvailableTransition,
} from "../transitions.js";

/**
 * Sürücüden bağımsız olan her şey — `AvailableTransition`, geçiş listesinin
 * ayrıştırılması, ada göre seçim, Türkçe i-katlaması ve geçiş id doğrulaması —
 * `../transitions.ts` içine taşındı ve Data Center sürücüsüyle PAYLAŞILIYOR
 * (M111: DC panelde statü haritası kuruldu, bkz. work-port.ts'teki
 * `transitionToStatus`). Buradan aynı adlarla yeniden dışa aktarılıyorlar, ki
 * bu modülün mevcut yüzeyi — içe aktaranlar, `src/index.ts` ve testler — bir
 * harf bile değişmesin. Aşağıda KALANLAR Cloud akışlarına özgü olanlar: İADE
 * (To-Do), İNCELEMEDE (In Progress) ve Done kategori seçicileri.
 */
export {
  foldStatusName,
  parseAvailableTransitions,
  requireTransitionId,
  selectTransitionByStatusName,
  type AvailableTransition,
};

/**
 * WRITING a Jira transition to hand an unfit ticket back to its reporter (İADE).
 *
 * The read-only `workflow.ts` layer maps a project's status graph for Studio's
 * import screen and never moves an issue. This module is its write counterpart,
 * built for the pilot's "İADE" (return) branch: when the intake role judges a
 * ticket too thin to analyse, Maestro does not merely ask and wait — it moves
 * the ticket to a backlog/To-Do status and reassigns it to the reporter, so the
 * ticket physically lands back in the reporter's court.
 *
 * A deliberate honesty note. The transition NAME is never hard-coded. Jira sites
 * rename their columns ("Yapılacaklar", "To Do", "Backlog", …) and a hard-coded
 * name would break the moment a site renames its board. Instead the target is
 * chosen by the status CATEGORY Jira itself reports on each available
 * transition's destination — the `To Do` category (Cloud key `new`) is the
 * backlog side of every Jira workflow regardless of the localised column name.
 * `GET /issue/{key}/transitions?expand=transitions.fields` returns each
 * transition WITH its destination status and that status's category, which is
 * exactly what the selection below reads.
 *
 * NOTHING here bypasses the frozen `WorkPort.transition` no-op: this is a
 * driver-specific capability reached through the concrete `JiraCloudWorkPort`
 * (the same shape as `addAttachment` / `readProjectWorkflow`), and the frozen
 * port surface is untouched.
 */

/** The status-category KEY Jira Cloud reports for a backlog/To-Do status. */
export const TODO_CATEGORY_KEY = "new";
/** The human-facing status-category NAME Jira Cloud reports for a To-Do status. */
export const TODO_CATEGORY_NAME = "To Do";

/** The status-category KEY / NAME Jira Cloud reports for a DONE status — where a
 * merged ticket is moved so it does not linger open after the work is finished. */
export const DONE_CATEGORY_KEY = "done";
export const DONE_CATEGORY_NAME = "Done";

/**
 * The status-category KEY / NAME Jira Cloud reports for an IN-PROGRESS status —
 * the category "İNCELEMEDE" (review) sits in. Used by the analysis-approval
 * handover (send-to-review): the review column is renamed per site, but its
 * CATEGORY is always `indeterminate` / "In Progress", so category is the honest
 * fallback when the preferred status name is not matched.
 */
export const IN_PROGRESS_CATEGORY_KEY = "indeterminate";
/** The human-facing status-category NAME Jira Cloud reports for an In-Progress status. */
export const IN_PROGRESS_CATEGORY_NAME = "In Progress";

/**
 * The DEFAULT review status name the analysis handover moves a ticket to, before
 * category fallback (the live OPS workflow's review column). NEVER the sole
 * selection key: a site may rename it, so `selectReviewTransition` matches this
 * name FIRST and then falls back to the In-Progress category.
 */
export const DEFAULT_REVIEW_STATUS_NAME = "İNCELEMEDE";

/**
 * Choose the transition that hands the ticket back to the backlog — the one
 * whose DESTINATION status sits in the `To Do` category. Selection is by
 * category, never by a hard-coded transition or status name:
 *
 *   1. A destination in the `To Do` category (key `new`, or name `To Do` for a
 *      site that omits the key) — the backlog side of the workflow.
 *   2. Among several To-Do destinations, the first Jira offers is used (Jira
 *      lists them in workflow order; the caller may narrow later).
 *
 * Returns `null` when the issue's current status offers NO To-Do transition
 * (e.g. it is already in a To-Do status, or the workflow forbids going back).
 * The caller treats that as "nothing to move" rather than an error, so an
 * already-backlogged ticket is not a failure.
 */
export function selectReturnTransition(
  transitions: readonly AvailableTransition[],
): AvailableTransition | null {
  for (const transition of transitions) {
    if (isTodoCategory(transition)) return transition;
  }
  return null;
}

function isTodoCategory(transition: AvailableTransition): boolean {
  return (
    transition.toCategoryKey.toLowerCase() === TODO_CATEGORY_KEY ||
    transition.toCategoryName.trim().toLowerCase() === TODO_CATEGORY_NAME.toLowerCase()
  );
}

/**
 * Choose the transition that CLOSES the ticket — the one whose destination sits
 * in the `Done` category. Selection is by category, never by a hard-coded status
 * name (a site renames "Done" to "Tamamlandı", "Kapandı" etc., but the CATEGORY
 * key stays `done`). Returns `null` when the current status offers no Done
 * transition (already closed, or the workflow forbids it); the caller treats
 * that as "nothing to move", never a failure — the merge already succeeded.
 */
export function selectDoneTransition(
  transitions: readonly AvailableTransition[],
): AvailableTransition | null {
  for (const transition of transitions) {
    if (isDoneCategory(transition)) return transition;
  }
  return null;
}

function isDoneCategory(transition: AvailableTransition): boolean {
  return (
    transition.toCategoryKey.toLowerCase() === DONE_CATEGORY_KEY ||
    transition.toCategoryName.trim().toLowerCase() === DONE_CATEGORY_NAME.toLowerCase()
  );
}

/**
 * Choose the transition that moves the ticket INTO REVIEW — the destination the
 * analysis-approval handover parks a ticket at while the Analyst Manager reviews
 * it. Selection is honest about localisation, in two ordered passes:
 *
 *   1. A destination whose status NAME equals `preferredName` (default
 *      "İNCELEMEDE"), case-insensitively — the exact review column when the site
 *      has one. This is preferred so that a workflow with several In-Progress
 *      statuses (e.g. "Devam Ediyor" AND "İNCELEMEDE", both `indeterminate`)
 *      lands on the review one, not merely the first in-progress edge.
 *   2. Failing that, the first destination in the `In Progress` category (key
 *      `indeterminate`, or name `In Progress`) — the honest fallback for a site
 *      that renamed its review column, since the CATEGORY is stable.
 *
 * Returns `null` when the current status offers NO in-progress transition (the
 * ticket may already be in review, or the workflow forbids it). The caller
 * treats that as "already there / cannot move", never a hard failure — the
 * handover still reassigns to the manager.
 */
export function selectReviewTransition(
  transitions: readonly AvailableTransition[],
  preferredName: string = DEFAULT_REVIEW_STATUS_NAME,
): AvailableTransition | null {
  const wanted = preferredName.trim().toLowerCase();
  if (wanted.length > 0) {
    for (const transition of transitions) {
      if (transition.toStatusName.trim().toLowerCase() === wanted) return transition;
    }
  }
  for (const transition of transitions) {
    if (isInProgressCategory(transition)) return transition;
  }
  return null;
}

function isInProgressCategory(transition: AvailableTransition): boolean {
  return (
    transition.toCategoryKey.toLowerCase() === IN_PROGRESS_CATEGORY_KEY ||
    transition.toCategoryName.trim().toLowerCase() === IN_PROGRESS_CATEGORY_NAME.toLowerCase()
  );
}
