import { useQuery } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";
import { useApi } from "../../auth/AuthProvider.tsx";
import type { FlowStatus, FlowTransition } from "./layout.ts";

/**
 * The Jira-workflow read model for the Flow screen (Dalga D).
 *
 * `GET /studio/jira-workflow?project=OPS` is the BFF endpoint P1 built
 * (apps/bff/src/routes/jira-workflow.ts); it reads the live OPS project off
 * Jira Cloud — the project's statuses and the transitions OBSERVED between them
 * — and hands back its own read model (apps/bff/src/jira-workflow-model.ts).
 * The type here MIRRORS that wire shape exactly; it is not re-invented, so the
 * screen and the server cannot drift.
 *
 * Two BFF facts the screen must respect:
 *   - `projectKey`, not `project` — the response echoes the key it read.
 *   - `edgesComplete` / `sampledFrom` — the edge set is what the sampled issues
 *     showed, NOT a proven-complete scheme (the full workflow-scheme API is
 *     Jira-admin-only). The screen states this rather than implying the graph
 *     is exhaustive.
 *
 * An admin-only, read-only surface: a deployment that wired no driver capable
 * of reading a project's workflow answers 503-by-name (`capability_not_wired`),
 * and `MaybeUnwired` turns a 404/501 into "not published yet" — never an empty
 * diagram that would read as "this project has no workflow".
 */

/** What `GET /studio/jira-workflow` returns — the BFF's `JiraWorkflowGraphView`. */
export interface JiraWorkflowView {
  /** The project key the statuses belong to, echoed back (e.g. "OPS"). */
  readonly projectKey: string;
  readonly statuses: readonly FlowStatus[];
  readonly transitions: readonly FlowTransition[];
  /** False when the edges were sampled from issues, not proven complete. */
  readonly edgesComplete: boolean;
  /** The issue keys the transitions were observed from. */
  readonly sampledFrom: readonly string[];
}

/** Re-exported for the screen and its tests, so there is one import site. */
export type { FlowStatus, FlowTransition };

/**
 * Read one project's Jira workflow.
 *
 * `enabled` is false for an empty project key so the screen can render its
 * "pick a project" state without firing a request for `?project=`. `retry` is
 * off: a 404 here is the deliberate "endpoint not built yet" signal that
 * `MaybeUnwired` reads, and retrying it only delays that message.
 */
export function useJiraWorkflow(project: string): UseQueryResult<JiraWorkflowView> {
  const api = useApi();
  return useQuery({
    queryKey: ["jira-workflow", project],
    queryFn: ({ signal }) =>
      api.get<JiraWorkflowView>("/studio/jira-workflow", {
        query: { project },
        signal,
      }),
    enabled: project !== "",
    retry: false,
  });
}
