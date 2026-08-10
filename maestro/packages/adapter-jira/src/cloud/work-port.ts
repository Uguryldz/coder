import { TicketKey, type CommandEnvelope, type TicketSnapshot } from "@maestro/contracts";
import { CapabilityNotSupportedError, type WorkPort } from "@maestro/ports";
import { toAdfDocument } from "../adf.js";
import type { FetchLike, TokenProvider } from "../client.js";
import {
  JiraArgumentError,
  JiraLinkFailedError,
  JiraMembershipUnresolvedError,
  JiraResponseError,
} from "../errors.js";
import { ISSUE_FIELDS } from "../mapping.js";
import { JiraCloudClient } from "./client.js";
import { commandFromCloudPayload, parseCommandFromComment, type CloudCommentCommand } from "./comment-command.js";
import type { JiraCloudConfig } from "./config.js";
import { cloudUserIdOf, mapCloudIssueToSnapshot } from "./mapping.js";
import { searchIssues, type CloudSearchPage, type CloudSearchRequest } from "./search.js";

export interface JiraCloudWorkPortOptions {
  config: JiraCloudConfig;
  /** Resolves the API token (usually `() => secrets.get(config.apiTokenRef)`). */
  token: TokenProvider;
  fetchImpl?: FetchLike;
}

const API = "/rest/api/3";
const MAX_GROUP_PAGES = 40;

/**
 * WorkPort driver for Jira Cloud. Same M102 permission stance as the DC
 * driver — Browse, Add Comment, Edit Issue (labels), Assign, Create/Link
 * Issue — with the Cloud-specific differences: REST v3, Basic auth
 * (email + API token), ADF bodies posted verbatim, `accountId` identities,
 * and NO webhooks: the pilot polls comments (see comment-command.ts).
 */
export class JiraCloudWorkPort implements WorkPort {
  readonly driver = "jira-cloud";
  private readonly client: JiraCloudClient;
  private readonly config: JiraCloudConfig;

  constructor(options: JiraCloudWorkPortOptions) {
    this.config = options.config;
    this.client = new JiraCloudClient({
      baseUrl: options.config.baseUrl,
      email: options.config.email,
      token: options.token,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.config.requestTimeoutMs,
    });
  }

  async getTicket(key: TicketKey): Promise<TicketSnapshot> {
    const issueKey = requireTicketKey(key, "key");
    const raw = await this.client.get<unknown>(`${API}/issue/${encodeURIComponent(issueKey)}`, {
      fields: ISSUE_FIELDS,
    });
    return mapCloudIssueToSnapshot(raw);
  }

  /**
   * `body` is an ADF document or a plain string. Cloud's REST v3 comment API
   * speaks ADF natively, so the document goes out verbatim — no wiki-markup
   * rendering (recorded 201: fixtures/cloud/comment-created-response.json).
   */
  async addComment(key: TicketKey, body: unknown): Promise<{ commentId: string }> {
    const issueKey = requireTicketKey(key, "key");
    const created = await this.client.post<unknown>(`${API}/issue/${encodeURIComponent(issueKey)}/comment`, {
      body: toAdfDocument(body),
    });
    return { commentId: requireId(created, "comment") };
  }

  /** Edit the single live status comment in place instead of spamming (M75). */
  async updateComment(key: TicketKey, commentId: string, body: unknown): Promise<void> {
    const issueKey = requireTicketKey(key, "key");
    if (commentId.trim().length === 0) throw new JiraArgumentError("commentId", "empty");
    const updated = await this.client.put<unknown>(
      `${API}/issue/${encodeURIComponent(issueKey)}/comment/${encodeURIComponent(commentId)}`,
      { body: toAdfDocument(body) },
    );
    requireId(updated, "comment");
  }

  /**
   * Diff-based label edit: read the current labels, then send only the
   * add/remove delta (recorded 204: PUT with `{update:{labels:[{add:…}]}}`).
   * Unlike the DC driver's full replacement, the delta cannot wipe labels a
   * human added between our read and write of an unrelated label.
   */
  async setLabels(key: TicketKey, labels: string[]): Promise<void> {
    const issueKey = requireTicketKey(key, "key");
    const desired = labels.map((label) => label.trim());
    for (const label of desired) {
      if (label.length === 0) throw new JiraArgumentError("labels", "empty label");
      if (/\s/.test(label)) throw new JiraArgumentError("labels", `Jira labels cannot contain whitespace: "${label}"`);
    }

    const raw = await this.client.get<unknown>(`${API}/issue/${encodeURIComponent(issueKey)}`, { fields: "labels" });
    const current = currentLabelsOf(raw);
    const wanted = new Set(desired);
    const have = new Set(current);
    const operations = [
      ...desired.filter((label) => !have.has(label)).map((label) => ({ add: label })),
      ...current.filter((label) => !wanted.has(label)).map((label) => ({ remove: label })),
    ];
    if (operations.length === 0) return;

    await this.client.put<void>(`${API}/issue/${encodeURIComponent(issueKey)}`, {
      update: { labels: operations },
    });
  }

  /** Cloud addresses the assignee by `accountId`; `null` unassigns. */
  async assign(key: TicketKey, accountId: string | null): Promise<void> {
    const issueKey = requireTicketKey(key, "key");
    const id = accountId === null ? null : accountId.trim();
    if (id !== null && id.length === 0) throw new JiraArgumentError("accountId", "empty");
    await this.client.put<void>(`${API}/issue/${encodeURIComponent(issueKey)}/assignee`, { accountId: id });
  }

  /**
   * Fan-out child (M100): create, then link back via POST /issueLink — NOT
   * the `parent` field. On a team-managed project `parent` demands the next
   * hierarchy level (an Epic), so a task could never fan out under a task;
   * an issue link of the configured type works at any level, exactly as on DC.
   */
  async createLinkedIssue(
    parent: TicketKey,
    fields: { summary: string; description: string; labels?: string[] },
  ): Promise<{ key: TicketKey }> {
    const parentKey = requireTicketKey(parent, "parent");
    const projectKey = parentKey.split("-")[0];
    if (!projectKey) throw new JiraArgumentError("parent", "cannot derive project key");
    if (fields.summary.trim().length === 0) throw new JiraArgumentError("summary", "empty");

    const created = await this.client.post<unknown>(`${API}/issue`, {
      fields: {
        project: { key: projectKey },
        summary: fields.summary,
        // v3 wants ADF here too; plain text is wrapped into paragraphs.
        description: toAdfDocument(fields.description),
        issuetype: { name: this.config.childIssueTypeName },
        ...(fields.labels && fields.labels.length > 0 ? { labels: fields.labels } : {}),
      },
    });

    const childKey = requireKey(created, "created issue");
    try {
      await this.client.post<void>(`${API}/issueLink`, {
        type: { name: this.config.linkTypeName },
        inwardIssue: { key: childKey },
        outwardIssue: { key: parentKey },
      });
    } catch (error) {
      throw new JiraLinkFailedError(childKey, parentKey, error);
    }
    return { key: childKey };
  }

  /**
   * Group membership backing gate authorisation (M32/M51) — same fail-closed
   * loop as the DC driver over the standard Cloud page bean, but matching
   * only on `accountId` and (when the site exposes it) the e-mail address.
   * No live fixture was recorded for this endpoint; see RAPOR.md.
   */
  async verifyMembership(userId: string, group: string): Promise<boolean> {
    const needle = userId.trim().toLowerCase();
    if (needle.length === 0) throw new JiraArgumentError("userId", "empty");
    if (group.trim().length === 0) throw new JiraArgumentError("group", "empty");

    let startAt = 0;
    for (let page = 0; page < MAX_GROUP_PAGES; page += 1) {
      const res = await this.client.get<unknown>(`${API}/group/member`, {
        groupname: group,
        includeInactiveUsers: false,
        startAt,
        maxResults: this.config.groupPageSize,
      });
      const body = asRecord(res);
      const values = Array.isArray(body?.["values"]) ? body["values"] : [];
      for (const member of values) {
        if (asRecord(member)?.["active"] === false) continue; // off-boarded — never passes a gate
        const id = cloudUserIdOf(member);
        const email = asRecord(member)?.["emailAddress"];
        const candidates = [id, typeof email === "string" ? email : null]
          .filter((c): c is string => typeof c === "string" && c.trim().length > 0)
          .map((c) => c.trim().toLowerCase());
        if (candidates.includes(needle)) return true;
      }
      if (values.length === 0) return false;
      startAt += values.length;
      if (!hasMorePages(body, startAt, group)) return false;
    }
    throw new JiraMembershipUnresolvedError(
      group,
      "too_many_pages",
      `stopped after ${MAX_GROUP_PAGES} pages of ${this.config.groupPageSize}`,
    );
  }

  /**
   * Bounded search on /rest/api/3/search/jql (the old /search is removed —
   * CHANGE-2046). Refuses unbounded JQL before it leaves the process.
   */
  searchIssues(request: CloudSearchRequest): Promise<CloudSearchPage> {
    return searchIssues(this.client, request);
  }

  /**
   * One page of an issue's comments, raw as recorded
   * (fixtures/cloud/comments-list.json) — the poll source that feeds
   * parseCommandFromComment, since the pilot receives no Cloud webhooks.
   */
  async listComments(key: TicketKey): Promise<unknown[]> {
    const issueKey = requireTicketKey(key, "key");
    const raw = await this.client.get<unknown>(`${API}/issue/${encodeURIComponent(issueKey)}/comment`, {});
    const comments = asRecord(raw)?.["comments"];
    if (!Array.isArray(comments)) throw new JiraResponseError("comments", ["response carries no comments array"]);
    return comments;
  }

  /** Poller payload → command, or null. Never throws on unknown commands. */
  async parseCommand(rawBody: unknown): Promise<CommandEnvelope | null> {
    return this.parseCommandDetailed(rawBody).envelope;
  }

  /** Same parse, keeping the "looks like a command but is malformed" result. */
  parseCommandDetailed(rawBody: unknown): CloudCommentCommand {
    return commandFromCloudPayload(rawBody);
  }

  /** Direct entry for the comment poller: one comment resource + its issue key. */
  parseCommandFromComment(ticketKey: string, comment: unknown): CloudCommentCommand {
    return parseCommandFromComment(ticketKey, comment);
  }

  /**
   * Not supported: the pilot POLLS comments — no Cloud webhook is registered,
   * no signature scheme was recorded, and fail-closed means a delivery this
   * driver cannot verify must never be treated as verified.
   */
  async verifyWebhook(_rawBody: string | Uint8Array, _headers: Record<string, string>): Promise<void> {
    throw new CapabilityNotSupportedError("WorkPort", "verifyWebhook");
  }

  /** Not supported for now (M102 parity): progress is shown via labels/comments. */
  async transition(_key: TicketKey, _transitionId: string): Promise<void> {
    throw new CapabilityNotSupportedError("WorkPort", "transition");
  }
}

function requireTicketKey(value: string, argument: string): TicketKey {
  const parsed = TicketKey.safeParse(value);
  if (!parsed.success) throw new JiraArgumentError(argument, `"${value}" is not a Jira issue key`);
  return parsed.data;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requireId(value: unknown, context: string): string {
  const id = asRecord(value)?.["id"];
  if (typeof id === "string" && id.length > 0) return id;
  if (typeof id === "number") return String(id);
  throw new JiraResponseError(context, ["response carries no id"]);
}

function requireKey(value: unknown, context: string): TicketKey {
  const key = asRecord(value)?.["key"];
  const parsed = typeof key === "string" ? TicketKey.safeParse(key) : null;
  if (!parsed?.success) throw new JiraResponseError(context, ["response carries no usable issue key"]);
  return parsed.data;
}

function currentLabelsOf(raw: unknown): string[] {
  const fields = asRecord(asRecord(raw)?.["fields"]);
  if (!fields) throw new JiraResponseError("issue.fields", ["label read returned no fields object"]);
  const labels = fields["labels"];
  return Array.isArray(labels)
    ? labels.filter((label): label is string => typeof label === "string" && label.trim().length > 0)
    : [];
}

/**
 * Same rule as on DC: a page bean carrying neither `isLast` nor a numeric
 * `total` cannot be reasoned about, and stopping there would silently deny a
 * real member — raise instead (M32 fail-closed, but never silent).
 */
function hasMorePages(body: Record<string, unknown> | null, startAt: number, group: string): boolean {
  const isLast = body?.["isLast"];
  if (typeof isLast === "boolean") return !isLast;
  const total = body?.["total"];
  if (typeof total === "number") return startAt < total;
  throw new JiraMembershipUnresolvedError(
    group,
    "incomplete_page_bean",
    "the member page carries neither a boolean isLast nor a numeric total",
  );
}
