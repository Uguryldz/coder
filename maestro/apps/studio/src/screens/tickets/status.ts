import type { RunStatus } from "../shared/runs.ts";

/**
 * Catalog key prefix for a workflow status.
 *
 * Exported so every screen renders the same word for the same status, and so
 * callers go through `useEnumLabel`: `WorkflowRunStatus` is a union in
 * TypeScript but a plain string on the wire, and an eighth status would
 * otherwise throw out of `t()` and blank the whole ticket list.
 */
export const RUN_STATUS_PREFIX = "run.status";

export function statusKey(status: RunStatus): string {
  return `${RUN_STATUS_PREFIX}.${status}`;
}
