import { CommandEnvelope, TicketKey } from "@maestro/contracts";
import { parseCommandBody, type CommandParseResult } from "./commands.js";
import { normalizeJiraDateTime } from "./datetime.js";
import { JiraArgumentError, JiraResponseError } from "./errors.js";
import { userIdOf } from "./mapping.js";

/**
 * Commands from POLLED Data Center comments.
 *
 * The DC driver's primary command path is the signed webhook
 * (`webhook.ts` → `commandFromWebhook`). It is not the only one that has to
 * work: a Data Center behind a corporate firewall frequently cannot call out
 * to Maestro at all, and then an `/approve` written on the ticket reaches
 * nothing — the gate waits forever and the run looks stuck for no reason
 * anybody can point at. This is the fallback path: list
 * `GET /rest/api/2/issue/{key}/comment` and feed each comment resource here.
 *
 * Sibling of `cloud/comment-command.ts`, deliberately NOT the same function.
 * A comment resource differs on the two products in exactly the two places
 * that matter here:
 *
 *  · BODY. REST v3 serves an ADF document; REST v2 serves a wiki-markup
 *    STRING. So there is no ADF walk to do — but there is no styling to
 *    inspect either. `{code}/approve{code}` on DC is a quoted command written
 *    as literal text, and `parseCommandBody` sees a line that does not start
 *    with `/` for the fenced forms, which is the same answer the ADF walk
 *    gives on Cloud.
 *  · AUTHOR. Cloud's only identity is `accountId`; DC has none, and carries
 *    `name` / `key` / `emailAddress` instead (`mapping.ts` → `userIdOf`).
 *    Running a DC comment through the Cloud parser threw "comment has no
 *    identifiable author" on every real Data Center thread — which is why the
 *    identity resolution here is the DC one, the same one the webhook path
 *    already uses.
 */

export interface DcCommentCommand {
  envelope: CommandEnvelope | null;
  /** Present when the comment looked like a command but could not be honoured. */
  invalid: Extract<CommandParseResult, { status: "invalid" }> | null;
}

const NO_COMMAND: DcCommentCommand = { envelope: null, invalid: null };

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Parse one DC comment resource into a command, or none. Never throws on an
 * unknown command — only on a payload too malformed to reason about.
 *
 * ONLY a never-edited comment can carry a command. This is the K-2 rule the
 * webhook path already enforces (`commandFromWebhook` refuses anything but a
 * `comment_created` whose timestamps agree), and it MUST hold here too or the
 * poller becomes a way around it: in Jira DC "Edit All Comments" is a routine
 * project-lead permission, so an edited comment keeps the original `author`
 * while a different `updateAuthor` supplied the text. Honouring it would let
 * anyone holding that permission approve a gate AS SOMEONE ELSE and walk
 * straight past the SoD matrix (M32/M51).
 *
 * Polling has no created/updated EVENT to distinguish — the timestamps are the
 * only evidence, so an absent `updated` is a hard error rather than an assumed
 * "unedited": a comment that cannot PROVE it was never edited must not open a
 * gate.
 */
export function parseDcCommandFromComment(ticketKey: string, comment: unknown): DcCommentCommand {
  const key = TicketKey.safeParse(ticketKey);
  if (!key.success) throw new JiraArgumentError("ticketKey", `"${ticketKey}" is not a Jira issue key`);
  const resource = record(comment);
  if (!resource) throw new JiraResponseError("dc comment", ["payload is not an object"]);

  // `body` on REST v2 is wiki markup, a plain string. `renderedBody` (returned
  // when the caller asks for it) is HTML and is deliberately NOT read: the
  // command grammar is defined over what the person typed, and reading the
  // rendered form would make `<p>/approve</p>` and a linkified `/approve`
  // indistinguishable from a typed one.
  const parsed = parseCommandBody(typeof resource["body"] === "string" ? resource["body"] : null);
  if (parsed.status === "none") return NO_COMMAND;

  const created = resource["created"];
  const updated = resource["updated"];
  if (typeof created !== "string") throw new JiraResponseError("dc comment", ["comment has no created timestamp"]);
  if (typeof updated !== "string") {
    throw new JiraResponseError("dc comment", ["comment has no updated timestamp — cannot prove it is unedited"]);
  }
  if (updated !== created) return NO_COMMAND;

  if (parsed.status === "invalid") return { envelope: null, invalid: parsed };

  // The WRITER, never `updateAuthor`. Same field the webhook path reads, and
  // the reason is the one above: the editor must never be able to speak as the
  // author.
  const author = userIdOf(resource["author"]);
  if (!author) throw new JiraResponseError("dc comment", ["comment has no identifiable author"]);

  return {
    envelope: CommandEnvelope.parse({
      ticketKey: key.data,
      author,
      at: normalizeJiraDateTime(created, "comment.created"),
      command: parsed.command,
    }),
    invalid: null,
  };
}
