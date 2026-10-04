import type { WorkPort } from "@maestro/ports";
import type { StatusMover } from "@maestro/workflows";

/**
 * Hand the worker the ability to MOVE a ticket between statuses ("durum
 * eşlemesi", the listening rule's status map).
 *
 * The same M44 split, and the same shape, as `doc-attacher.ts` next door.
 * `WorkPort` is FROZEN: its `transition()` takes a transition ID, which belongs
 * to one project's workflow and means nothing on another, while a listening
 * rule names a STATUS. The by-name capability lives on the CONCRETE Jira
 * drivers (`transitionToStatus` — Cloud since M44, Data Center since M111), so
 * `@maestro/workflows` declares the SHAPE it needs and this file — in the
 * composition root — is the one place allowed to know which driver satisfies it.
 *
 * Detection is STRUCTURAL, not `instanceof`, for the reason spelled out in
 * `doc-attacher.ts`: importing `JiraCloudWorkPort` here would put an adapter
 * class inside a wiring decision the registry already made, and would break the
 * day a second driver grows the same method. Anything that can move a ticket
 * gets to; anything that cannot is `undefined`, and the flow stays in
 * comment-only mode with the journal saying why.
 */

/** The concrete drivers' signature, as `transitionToStatus` has it on both. */
type TransitionFn = (
  ticket: string,
  statusName: string,
) => Promise<{ moved: boolean; reason?: string }>;

/**
 * The mover this deployment's work driver supports, or `undefined`.
 *
 * `undefined` is a supported answer, not a degradation to paper over: a driver
 * that cannot move a ticket at all (a future non-Jira work port) is better off
 * with no seam than with a stub that fills every run's journal with a failure
 * for a capability the deployment was never going to have.
 *
 * NOT the answer for a MISSING PERMISSION, though. Both Jira drivers now carry
 * `transitionToStatus`, so both get a mover; whether the service account is
 * actually allowed to transition is decided by JIRA, per call, and comes back
 * as `{moved:false, reason:"forbidden"}` — a reason the run logs and continues
 * past. Deciding it here, once at boot, would silently turn a fixable
 * permission grant into "the status map does nothing" for the life of the
 * process. (M111 — before it, the DC driver had no such method and every
 * mapped run on a Data Center site degraded to comment-only mode.)
 */
export function statusMoverFor(work: WorkPort): StatusMover | undefined {
  const candidate = (work as Partial<Record<"transitionToStatus", unknown>>).transitionToStatus;
  if (typeof candidate !== "function") return undefined;
  const move = candidate.bind(work) as TransitionFn;
  return { move: (ticket, statusName) => move(ticket, statusName) };
}
