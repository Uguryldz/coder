import { parseWebhookEvent } from "@maestro/adapter-jira";
import type { WorkEvent, WorkEventReader } from "@maestro/bff";

/**
 * The `WorkEventReader` the BFF injects.
 *
 * `WorkPort` has no `parseEvent`, so the BFF declares the narrow shape it needs
 * out of a VERIFIED delivery and the composition root builds it from the same
 * driver the work port came from. Deriving it here — rather than in the BFF —
 * is what keeps `apps/bff` free of a Jira import (M44).
 *
 * The reader is deliberately not a re-implementation: it delegates to the
 * driver's own `parseWebhookEvent` and only narrows the result. A second
 * parser would be a second grammar to keep in step with Jira, and the two
 * would drift on the first payload shape nobody thought to test.
 */
export function jiraWorkEventReader(): WorkEventReader {
  return {
    read(payload: unknown): WorkEvent {
      const event = parseWebhookEvent(payload);
      if (event.kind === "other") return { kind: "other" };

      // Labels decide whether an `opt_in` project takes the ticket at all
      // (M48a), so they are read from the issue the driver already validated
      // rather than from the raw envelope.
      const labels = labelsOf(event.issue);
      return {
        kind: event.kind,
        ticketKey: event.ticketKey,
        ...(labels === null ? {} : { labels }),
      };
    },
  };
}

/**
 * `issue.fields.labels`, or `null` when the payload carries none.
 *
 * `null` and `[]` are different answers and the difference matters: an empty
 * array says "this ticket has no labels", which in an `opt_in` project means
 * "do not take it". A payload that simply omitted the field must not be read
 * as that, so it stays absent and the caller decides.
 */
function labelsOf(issue: unknown): string[] | null {
  const fields = asRecord(asRecord(issue)?.["fields"]);
  const labels = fields?.["labels"];
  if (!Array.isArray(labels)) return null;
  return labels.filter((label): label is string => typeof label === "string");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
