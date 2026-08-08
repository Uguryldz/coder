import { CiResultSignal } from "@maestro/contracts";
import type { CiPort } from "@maestro/ports";
import { z } from "zod";
import { extractPullRequestId, extractTicketKey } from "./branch.js";
import { AdoResponseError } from "./errors.js";
import { parseOrThrow } from "./parse.js";
import { BuildCompleteResource, ServiceHookEnvelope } from "./schemas.js";

/** The only Service Hook event type this driver acts on (M12). */
export const BUILD_COMPLETE_EVENT = "build.complete";

/**
 * ADO build results → gate outcome. Anything that is not a clean success
 * counts as failed: `partiallySucceeded` means some test/step failed, and a
 * cancelled build proves nothing. Fail-closed at the CI gate (10b).
 */
const BUILD_RESULT: Record<string, CiResultSignal["status"]> = {
  succeeded: "succeeded",
  partiallySucceeded: "failed",
  failed: "failed",
  canceled: "failed",
  cancelled: "failed",
  none: "failed",
};

/**
 * CiPort driver "ado" — PASSIVE (M12). Maestro never triggers a pipeline:
 * the ADO branch policy runs build validation on the PR and the
 * `build.complete` Service Hook is parsed here into the workflow signal.
 *
 * The parser returns null (= "ignore this webhook") in three cases, so the
 * webhook endpoint can answer 200 without inventing a signal:
 *   1. the event is not `build.complete` (push, PR update, work item…);
 *   2. the build is not a PR validation build — no pull request id in
 *      `triggerInfo["pr.number"]` and no `refs/pull/<id>/merge` source ref;
 *   3. no Jira ticket key in the source branch (M49
 *      `feature/<TICKET-KEY>-*`) — e.g. a hand-made branch or a release
 *      branch. Guessing a key would signal the wrong workflow run.
 *
 * A `build.complete` payload that IS a Maestro build but whose fields do
 * not validate throws instead of returning null: silence there would hang
 * the 10b gate forever.
 */
export class AdoCiDriver implements CiPort {
  parseBuildEvent(rawBody: unknown): Promise<CiResultSignal | null> {
    return Promise.resolve(parseBuildCompleteEvent(rawBody));
  }
}

/** Synchronous core of {@link AdoCiDriver.parseBuildEvent}. */
export function parseBuildCompleteEvent(rawBody: unknown): CiResultSignal | null {
  const envelope = ServiceHookEnvelope.safeParse(rawBody);
  if (!envelope.success) return null;
  if (envelope.data.eventType !== BUILD_COMPLETE_EVENT) return null;

  const resource = parseOrThrow(BuildCompleteResource, envelope.data.resource, "build.complete resource");
  const trigger = resource.triggerInfo ?? {};

  // Refs a build event can carry, most specific first. On a PR validation
  // build `sourceBranch` is the merge ref (refs/pull/<id>/merge) and the
  // real branch lives in triggerInfo; resourceVersion 1.0 payloads (older
  // on-prem subscriptions) carry neither and only have sourceGetVersion.
  const refs = [
    trigger["pr.sourceBranch"],
    resource.sourceBranch,
    refFromSourceGetVersion(resource.sourceGetVersion),
  ].filter((ref): ref is string => typeof ref === "string" && ref.length > 0);

  const prId =
    parsePositiveInt(trigger["pr.number"]) ??
    firstNonNull(refs, extractPullRequestId);
  if (prId === null) return null;

  const ticketKey = firstNonNull(refs, extractTicketKey);
  if (ticketKey === null) return null;

  const finishedAt = toIsoDateTime(
    resource.finishTime ?? resource.lastChangedDate ?? envelope.data.createdDate,
  );
  if (finishedAt === null) {
    throw new AdoResponseError("build.complete resource", [
      `no usable finish time for ${ticketKey} (build ${resource.id})`,
    ]);
  }

  const detailsUrl = z.url().safeParse(resource._links?.web?.href);

  return parseOrThrow(CiResultSignal, {
    ticketKey,
    prId,
    buildId: resource.id,
    status: buildOutcome(resource.result, resource.status),
    ...(detailsUrl.success ? { detailsUrl: detailsUrl.data } : {}),
    finishedAt,
  }, "build.complete signal");
}

/**
 * Outcome of the build across both payload generations: resourceVersion 2.0
 * puts the verdict in `result` (with `status: "completed"`), while the older
 * 1.0 shape puts it straight in `status`. Anything unrecognised is failed.
 */
function buildOutcome(result: string | undefined, status: string | undefined): CiResultSignal["status"] {
  const verdict = result ?? (status === "completed" ? undefined : status);
  return (verdict !== undefined ? BUILD_RESULT[verdict] : undefined) ?? "failed";
}

/** `sourceGetVersion` of a 1.0 payload: "LG:refs/heads/feature/X-1:<sha>". */
function refFromSourceGetVersion(value: string | undefined): string | undefined {
  return /^[A-Z]{2}:(refs\/[^:]+)/.exec(value ?? "")?.[1];
}

function firstNonNull<T>(values: readonly string[], extract: (value: string) => T | null): T | null {
  for (const value of values) {
    const extracted = extract(value);
    if (extracted !== null) return extracted;
  }
  return null;
}

function parsePositiveInt(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value.trim())) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Normalises an ADO timestamp to the contract's ISO form. ADO emits
 * 7-digit fractional seconds, and on-prem instances occasionally omit the
 * zone — which is read as UTC here rather than as the parser's local time,
 * so the result does not depend on the server's clock settings.
 */
function toIsoDateTime(raw: string | undefined): string | null {
  if (raw === undefined || raw.trim() === "") return null;
  const value = raw.trim();
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value}Z`;
  const date = new Date(zoned);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
