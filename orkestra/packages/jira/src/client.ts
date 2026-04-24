import { createLogger, loadConfig } from "@orkestra/config";
import { JiraTicket, JiraUser } from "@orkestra/contracts";
import axios, { AxiosInstance, AxiosResponse } from "axios";
import { z } from "zod";
import type { AdfDoc } from "./adf.js";

const log = createLogger("jira.client");

// ---------------------------------------------------------------------------
// Wire schemas — raw Jira REST shapes (only the fields we touch)
// ---------------------------------------------------------------------------

const JiraRestUser = z.object({
  accountId: z.string().optional(),
  key: z.string().optional(),
  name: z.string().optional(),
  displayName: z.string().optional(),
  emailAddress: z.string().optional(),
});

const JiraRestIssueFields = z
  .object({
    summary: z.string().default(""),
    description: z.unknown().optional(),
    project: z.object({ key: z.string() }),
    issuetype: z.object({ name: z.string() }).optional(),
    status: z.object({ name: z.string() }).optional(),
    priority: z.object({ name: z.string() }).optional().nullable(),
    labels: z.array(z.string()).default([]),
    components: z.array(z.object({ name: z.string() })).default([]),
    reporter: JiraRestUser.nullable().optional(),
    assignee: JiraRestUser.nullable().optional(),
    duedate: z.string().nullable().optional(),
  })
  .passthrough();

const JiraRestIssue = z.object({
  id: z.string(),
  key: z.string(),
  fields: JiraRestIssueFields,
});

const JiraRestTransition = z.object({
  id: z.string(),
  name: z.string(),
  to: z.object({ id: z.string(), name: z.string() }).optional(),
});

const JiraRestTransitionsResponse = z.object({
  transitions: z.array(JiraRestTransition).default([]),
});

const JiraRestSearchResponse = z.object({
  issues: z.array(JiraRestIssue).default([]),
  total: z.number().optional(),
});

export type JiraTransition = z.infer<typeof JiraRestTransition>;

export type JiraAuthMode = "basic" | "api_token" | "pat";

export interface JiraClientOptions {
  baseUrl?: string;
  /**
   * Auth mode:
   * - `basic`      → HTTP Basic (username + password) — Jira Server / on-prem DC
   * - `api_token`  → HTTP Basic (email + API token)  — Jira Cloud (default)
   * - `pat`        → Bearer token                    — Jira DC 8.14+ Personal Access Token
   */
  authMode?: JiraAuthMode;
  username?: string;
  /** Password for `basic`, API token for `api_token`, PAT for `pat`. */
  apiToken?: string;
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// ADF detection + description flattening
// ---------------------------------------------------------------------------

function isAdfDoc(v: unknown): v is AdfDoc {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as { type?: string }).type === "doc" &&
    Array.isArray((v as { content?: unknown[] }).content)
  );
}

function flattenAdfToText(node: unknown): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(flattenAdfToText).join("");
  if (typeof node === "object") {
    const n = node as { type?: string; text?: string; content?: unknown };
    if (typeof n.text === "string") return n.text;
    const inner = flattenAdfToText(n.content ?? []);
    // paragraph-ish blocks: add newline
    if (n.type === "paragraph" || n.type === "heading" || n.type === "listItem") {
      return inner + "\n";
    }
    return inner;
  }
  return "";
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class JiraClient {
  private readonly http: AxiosInstance;
  private readonly baseUrl: string;

  constructor(opts: JiraClientOptions = {}) {
    const cfg = loadConfig();
    this.baseUrl = (opts.baseUrl ?? cfg.JIRA_BASE_URL).replace(/\/+$/, "");
    const authMode: JiraAuthMode = opts.authMode ?? "api_token";
    const username = opts.username ?? cfg.JIRA_USERNAME;
    const secret = opts.apiToken ?? cfg.JIRA_API_TOKEN;

    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    let basicAuth: { username: string; password: string } | undefined;

    if (authMode === "pat") {
      if (secret) headers.Authorization = `Bearer ${secret}`;
    } else {
      // `basic` and `api_token` are both HTTP Basic on the wire; the only
      // difference is what goes into the password slot (real password vs token).
      if (username && secret) basicAuth = { username, password: secret };
    }

    this.http = axios.create({
      baseURL: this.baseUrl,
      timeout: opts.timeoutMs ?? 15_000,
      auth: basicAuth,
      headers,
    });

    this.http.interceptors.request.use((req) => {
      (req as { _startedAt?: number })._startedAt = Date.now();
      return req;
    });
    this.http.interceptors.response.use(
      (res: AxiosResponse) => {
        const started = (res.config as { _startedAt?: number })._startedAt ?? Date.now();
        log.debug(
          {
            method: res.config.method,
            url: res.config.url,
            status: res.status,
            durationMs: Date.now() - started,
          },
          "jira.http",
        );
        return res;
      },
      (err: unknown) => {
        if (axios.isAxiosError(err)) {
          const started =
            (err.config as { _startedAt?: number } | undefined)?._startedAt ?? Date.now();
          log.warn(
            {
              method: err.config?.method,
              url: err.config?.url,
              status: err.response?.status,
              durationMs: Date.now() - started,
              data: err.response?.data,
            },
            "jira.http.error",
          );
        }
        return Promise.reject(err);
      },
    );
  }

  // -------------------------------------------------------------------------
  // Issues
  // -------------------------------------------------------------------------

  async getIssue(key: string): Promise<JiraTicket> {
    try {
      const res = await this.http.get(`/rest/api/2/issue/${encodeURIComponent(key)}`);
      const parsed = JiraRestIssue.parse(res.data);
      return this.toTicket(parsed);
    } catch (err) {
      throw new Error(`[jira] getIssue ${key}: ${errMsg(err)}`);
    }
  }

  async searchIssues(jql: string, maxResults = 50): Promise<JiraTicket[]> {
    try {
      const res = await this.http.get(`/rest/api/2/search`, {
        params: { jql, maxResults },
      });
      const parsed = JiraRestSearchResponse.parse(res.data);
      return parsed.issues.map((i) => this.toTicket(i));
    } catch (err) {
      throw new Error(`[jira] searchIssues: ${errMsg(err)}`);
    }
  }

  async addComment(key: string, body: string | AdfDoc): Promise<void> {
    try {
      // ADF comments are the /rest/api/3 shape (Cloud); v2 accepts plain string.
      if (isAdfDoc(body)) {
        // Prefer v3 body.body (ADF).
        try {
          await this.http.post(`/rest/api/3/issue/${encodeURIComponent(key)}/comment`, {
            body,
          });
          return;
        } catch (errV3) {
          // DC fallback: downgrade ADF to plain text on v2.
          log.debug({ key, err: errMsg(errV3) }, "adf comment fell back to plain text");
          const text = flattenAdfToText(body).trim();
          await this.http.post(`/rest/api/2/issue/${encodeURIComponent(key)}/comment`, {
            body: text,
          });
          return;
        }
      }
      await this.http.post(`/rest/api/2/issue/${encodeURIComponent(key)}/comment`, {
        body,
      });
    } catch (err) {
      throw new Error(`[jira] addComment ${key}: ${errMsg(err)}`);
    }
  }

  async getTransitions(key: string): Promise<JiraTransition[]> {
    try {
      const res = await this.http.get(`/rest/api/2/issue/${encodeURIComponent(key)}/transitions`);
      return JiraRestTransitionsResponse.parse(res.data).transitions;
    } catch (err) {
      throw new Error(`[jira] getTransitions ${key}: ${errMsg(err)}`);
    }
  }

  async transitionIssue(key: string, transitionName: string): Promise<void> {
    const transitions = await this.getTransitions(key);
    const match =
      transitions.find((t) => t.name.toLowerCase() === transitionName.toLowerCase()) ??
      transitions.find((t) => t.to?.name?.toLowerCase() === transitionName.toLowerCase());
    if (!match) {
      throw new Error(
        `[jira] transitionIssue ${key}: transition "${transitionName}" not available (have: ${transitions
          .map((t) => t.name)
          .join(", ")})`,
      );
    }
    try {
      await this.http.post(`/rest/api/2/issue/${encodeURIComponent(key)}/transitions`, {
        transition: { id: match.id },
      });
    } catch (err) {
      throw new Error(`[jira] transitionIssue ${key} -> ${transitionName}: ${errMsg(err)}`);
    }
  }

  // -------------------------------------------------------------------------
  // Users
  // -------------------------------------------------------------------------

  async getUser(accountId: string): Promise<JiraUser> {
    try {
      const res = await this.http.get(`/rest/api/2/user`, { params: { accountId } });
      const parsed = JiraRestUser.parse(res.data);
      return JiraUser.parse({
        accountId: parsed.accountId ?? parsed.key ?? parsed.name ?? accountId,
        name: parsed.displayName ?? parsed.name,
        email: parsed.emailAddress,
      });
    } catch (err) {
      throw new Error(`[jira] getUser ${accountId}: ${errMsg(err)}`);
    }
  }

  // -------------------------------------------------------------------------
  // Normalization
  // -------------------------------------------------------------------------

  private toTicket(issue: z.infer<typeof JiraRestIssue>): JiraTicket {
    const f = issue.fields;
    const description =
      typeof f.description === "string"
        ? f.description
        : f.description
          ? flattenAdfToText(f.description).trim()
          : "";

    const reporter = f.reporter
      ? JiraUser.parse({
          accountId: f.reporter.accountId ?? f.reporter.key ?? f.reporter.name ?? "unknown",
          name: f.reporter.displayName ?? f.reporter.name,
          email: f.reporter.emailAddress,
        })
      : undefined;
    const assignee = f.assignee
      ? JiraUser.parse({
          accountId: f.assignee.accountId ?? f.assignee.key ?? f.assignee.name ?? "unknown",
          name: f.assignee.displayName ?? f.assignee.name,
          email: f.assignee.emailAddress,
        })
      : undefined;

    return JiraTicket.parse({
      id: issue.id,
      key: issue.key,
      projectKey: f.project.key,
      summary: f.summary,
      description,
      issueType: f.issuetype?.name ?? "Task",
      status: f.status?.name ?? "Open",
      priority: f.priority?.name,
      labels: f.labels,
      components: f.components.map((c) => c.name),
      reporter,
      assignee,
      dueDate: f.duedate ?? undefined,
      customFields: extractCustomFields(f),
      rawContent: issue,
    });
  }
}

function extractCustomFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (k.startsWith("customfield_")) out[k] = v;
  }
  return out;
}

function errMsg(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    const data = err.response?.data;
    return `${status ?? "?"} ${typeof data === "string" ? data : JSON.stringify(data ?? err.message)}`;
  }
  return err instanceof Error ? err.message : String(err);
}
