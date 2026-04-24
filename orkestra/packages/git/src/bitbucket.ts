import { createLogger, loadConfig } from "@orkestra/config";
import axios, { AxiosInstance, AxiosResponse } from "axios";
import { spawn } from "node:child_process";
import { z } from "zod";
import type {
  Branch,
  CreatePullRequestParams,
  GitClient,
  PullRequest,
  PullRequestActivity,
  PullRequestComment,
  PullRequestRef,
  PushChangesParams,
  Repo,
  RepoRef,
} from "./index.js";

const log = createLogger("git.bitbucket");

// ---------------------------------------------------------------------------
// Wire schemas (Bitbucket DC REST v1)
// ---------------------------------------------------------------------------

const BbRepo = z
  .object({
    id: z.number(),
    slug: z.string(),
    name: z.string(),
    project: z.object({ key: z.string() }),
    defaultBranch: z.string().optional(),
    links: z
      .object({
        clone: z.array(z.object({ href: z.string(), name: z.string() })).optional(),
        self: z.array(z.object({ href: z.string() })).optional(),
      })
      .optional(),
  })
  .passthrough();

const BbBranch = z.object({
  id: z.string(),
  displayId: z.string(),
  latestCommit: z.string(),
  type: z.string().optional(),
});

const BbBranchesResp = z.object({ values: z.array(BbBranch).default([]) });

const BbUser = z
  .object({
    name: z.string().optional(),
    displayName: z.string().optional(),
    emailAddress: z.string().optional(),
  })
  .passthrough();

const BbPR = z
  .object({
    id: z.number(),
    title: z.string(),
    description: z.string().default(""),
    state: z.string(),
    fromRef: z.object({ displayId: z.string(), latestCommit: z.string().optional() }),
    toRef: z.object({ displayId: z.string() }),
    author: z.object({ user: BbUser }).optional(),
    createdDate: z.number().optional(),
    updatedDate: z.number().optional(),
    links: z.object({ self: z.array(z.object({ href: z.string() })).optional() }).optional(),
  })
  .passthrough();

const BbComment = z
  .object({
    id: z.number(),
    text: z.string(),
    author: BbUser.optional(),
    createdDate: z.number().optional(),
  })
  .passthrough();

const BbActivity = z
  .object({
    id: z.number(),
    action: z.string(),
    createdDate: z.number().optional(),
  })
  .passthrough();

const BbActivitiesResp = z.object({ values: z.array(BbActivity).default([]) });
const BbCommentsResp = z.object({ values: z.array(BbComment).default([]) });

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface BitbucketClientOptions {
  baseUrl?: string;
  username?: string;
  appPassword?: string;
  timeoutMs?: number;
}

export class BitbucketClient implements GitClient {
  readonly platform = "bitbucket" as const;

  private readonly http: AxiosInstance;
  private readonly baseUrl: string;

  constructor(opts: BitbucketClientOptions = {}) {
    const cfg = loadConfig();
    this.baseUrl = (opts.baseUrl ?? cfg.BITBUCKET_BASE_URL).replace(/\/+$/, "");
    const username = opts.username ?? cfg.BITBUCKET_USERNAME;
    const password = opts.appPassword ?? cfg.BITBUCKET_APP_PASSWORD;

    this.http = axios.create({
      baseURL: this.baseUrl,
      timeout: opts.timeoutMs ?? 15_000,
      auth: username ? { username, password } : undefined,
      headers: { Accept: "application/json", "Content-Type": "application/json" },
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
          "bb.http",
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
            "bb.http.error",
          );
        }
        return Promise.reject(err);
      },
    );
  }

  // -------------------------------------------------------------------------
  // Repos + branches
  // -------------------------------------------------------------------------

  async getRepo(projectKey: string, repoSlug: string): Promise<Repo> {
    try {
      const res = await this.http.get(
        `/rest/api/1.0/projects/${encodeURIComponent(projectKey)}/repos/${encodeURIComponent(repoSlug)}`,
      );
      const r = BbRepo.parse(res.data);
      const httpClone = r.links?.clone?.find((l) => l.name === "http")?.href;
      const sshClone = r.links?.clone?.find((l) => l.name === "ssh")?.href;
      const self = r.links?.self?.[0]?.href ?? "";
      return {
        id: r.id,
        projectKey: r.project.key,
        repoSlug: r.slug,
        name: r.name,
        defaultBranch: r.defaultBranch,
        cloneUrl: httpClone ?? sshClone ?? "",
        webUrl: self,
      };
    } catch (err) {
      throw new Error(`[git.bitbucket] getRepo ${projectKey}/${repoSlug}: ${errMsg(err)}`);
    }
  }

  async getBranch(repo: RepoRef, branchName: string): Promise<Branch> {
    try {
      const res = await this.http.get(
        `/rest/api/1.0/projects/${encodeURIComponent(repo.projectKey)}/repos/${encodeURIComponent(
          repo.repoSlug,
        )}/branches`,
        { params: { filterText: branchName, limit: 25 } },
      );
      const resp = BbBranchesResp.parse(res.data);
      const match = resp.values.find(
        (b) => b.displayId === branchName || b.id === `refs/heads/${branchName}`,
      );
      if (!match) throw new Error(`branch "${branchName}" not found`);
      return { name: match.displayId, commitId: match.latestCommit };
    } catch (err) {
      throw new Error(
        `[git.bitbucket] getBranch ${repo.projectKey}/${repo.repoSlug}:${branchName}: ${errMsg(err)}`,
      );
    }
  }

  async createBranch(repo: RepoRef, branchName: string, fromCommit: string): Promise<Branch> {
    try {
      const res = await this.http.post(
        `/rest/branch-utils/1.0/projects/${encodeURIComponent(repo.projectKey)}/repos/${encodeURIComponent(
          repo.repoSlug,
        )}/branches`,
        { name: branchName, startPoint: fromCommit },
      );
      const b = BbBranch.parse(res.data);
      return { name: b.displayId, commitId: b.latestCommit };
    } catch (err) {
      throw new Error(
        `[git.bitbucket] createBranch ${repo.projectKey}/${repo.repoSlug}:${branchName}: ${errMsg(err)}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Pull requests
  // -------------------------------------------------------------------------

  async createPullRequest(params: CreatePullRequestParams): Promise<PullRequest> {
    const { repo, source, target, title, description, reviewers } = params;
    try {
      const res = await this.http.post(
        `/rest/api/1.0/projects/${encodeURIComponent(repo.projectKey)}/repos/${encodeURIComponent(
          repo.repoSlug,
        )}/pull-requests`,
        {
          title,
          description,
          state: "OPEN",
          open: true,
          closed: false,
          fromRef: {
            id: `refs/heads/${source}`,
            repository: { slug: repo.repoSlug, project: { key: repo.projectKey } },
          },
          toRef: {
            id: `refs/heads/${target}`,
            repository: { slug: repo.repoSlug, project: { key: repo.projectKey } },
          },
          reviewers: (reviewers ?? []).map((r) => ({ user: { name: r.name } })),
        },
      );
      return this.toPullRequest(res.data, repo);
    } catch (err) {
      throw new Error(
        `[git.bitbucket] createPullRequest ${repo.projectKey}/${repo.repoSlug} ${source}->${target}: ${errMsg(err)}`,
      );
    }
  }

  async getPullRequest(pr: PullRequestRef): Promise<PullRequest> {
    try {
      const res = await this.http.get(
        `/rest/api/1.0/projects/${encodeURIComponent(pr.repo.projectKey)}/repos/${encodeURIComponent(
          pr.repo.repoSlug,
        )}/pull-requests/${pr.id}`,
      );
      return this.toPullRequest(res.data, pr.repo);
    } catch (err) {
      throw new Error(
        `[git.bitbucket] getPullRequest ${pr.repo.projectKey}/${pr.repo.repoSlug}#${pr.id}: ${errMsg(err)}`,
      );
    }
  }

  async addPullRequestComment(pr: PullRequestRef, text: string): Promise<PullRequestComment> {
    try {
      const res = await this.http.post(
        `/rest/api/1.0/projects/${encodeURIComponent(pr.repo.projectKey)}/repos/${encodeURIComponent(
          pr.repo.repoSlug,
        )}/pull-requests/${pr.id}/comments`,
        { text },
      );
      return this.toComment(res.data);
    } catch (err) {
      throw new Error(
        `[git.bitbucket] addPullRequestComment ${pr.repo.projectKey}/${pr.repo.repoSlug}#${pr.id}: ${errMsg(err)}`,
      );
    }
  }

  async listPullRequestComments(pr: PullRequestRef): Promise<PullRequestComment[]> {
    try {
      const res = await this.http.get(
        `/rest/api/1.0/projects/${encodeURIComponent(pr.repo.projectKey)}/repos/${encodeURIComponent(
          pr.repo.repoSlug,
        )}/pull-requests/${pr.id}/comments`,
        { params: { limit: 100 } },
      );
      // DC returns activity-like structures for comments on this endpoint
      // depending on version; accept either.
      const raw = res.data as { values?: unknown };
      const list = Array.isArray(raw.values) ? raw.values : [];
      const parsed = z.array(BbComment).safeParse(list);
      return (parsed.success ? parsed.data : []).map((c) => this.toComment(c));
    } catch (err) {
      throw new Error(
        `[git.bitbucket] listPullRequestComments ${pr.repo.projectKey}/${pr.repo.repoSlug}#${pr.id}: ${errMsg(
          err,
        )}`,
      );
    }
  }

  async getPullRequestActivity(pr: PullRequestRef): Promise<PullRequestActivity[]> {
    try {
      const res = await this.http.get(
        `/rest/api/1.0/projects/${encodeURIComponent(pr.repo.projectKey)}/repos/${encodeURIComponent(
          pr.repo.repoSlug,
        )}/pull-requests/${pr.id}/activities`,
        { params: { limit: 100 } },
      );
      const resp = BbActivitiesResp.parse(res.data);
      return resp.values.map((a) => ({
        id: a.id,
        action: a.action,
        createdAt: a.createdDate ? new Date(a.createdDate).toISOString() : new Date().toISOString(),
        raw: a,
      }));
    } catch (err) {
      throw new Error(
        `[git.bitbucket] getPullRequestActivity ${pr.repo.projectKey}/${pr.repo.repoSlug}#${pr.id}: ${errMsg(
          err,
        )}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Branch restrictions
  // -------------------------------------------------------------------------

  async setBranchRestriction(
    repo: RepoRef,
    pattern: string,
    opts: { fastForward?: boolean; noForcePush?: boolean } = {},
  ): Promise<void> {
    const { fastForward = true, noForcePush = true } = opts;
    const restrictions: Array<Record<string, unknown>> = [];
    if (noForcePush) {
      restrictions.push({
        type: "no-deletes",
        matcher: {
          id: pattern,
          displayId: pattern,
          type: { id: "PATTERN", name: "Pattern" },
          active: true,
        },
      });
      restrictions.push({
        type: "fast-forward-only",
        matcher: {
          id: pattern,
          displayId: pattern,
          type: { id: "PATTERN", name: "Pattern" },
          active: true,
        },
      });
    }
    if (!fastForward) {
      // opting out of fast-forward-only — remove the constraint
      restrictions.length = 0;
    }
    try {
      for (const body of restrictions) {
        await this.http.post(
          `/rest/branch-permissions/2.0/projects/${encodeURIComponent(
            repo.projectKey,
          )}/repos/${encodeURIComponent(repo.repoSlug)}/restrictions`,
          body,
          { headers: { "Content-Type": "application/vnd.atl.bitbucket.bulk+json" } },
        );
      }
    } catch (err) {
      throw new Error(
        `[git.bitbucket] setBranchRestriction ${repo.projectKey}/${repo.repoSlug} ${pattern}: ${errMsg(err)}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Local git helper (push via shelling out — NOT via REST)
  // -------------------------------------------------------------------------

  async pushChanges(params: PushChangesParams): Promise<{ commitSha: string }> {
    const { workdir, branch, commitMessage, authorName, authorEmail, filesToAdd } = params;
    const env = { ...process.env } as NodeJS.ProcessEnv;
    if (authorName) env.GIT_AUTHOR_NAME = authorName;
    if (authorEmail) env.GIT_AUTHOR_EMAIL = authorEmail;
    if (authorName) env.GIT_COMMITTER_NAME = authorName;
    if (authorEmail) env.GIT_COMMITTER_EMAIL = authorEmail;

    const addTargets = filesToAdd && filesToAdd.length > 0 ? filesToAdd : ["."];
    await runGit(["checkout", "-B", branch], workdir, env);
    await runGit(["add", "--", ...addTargets], workdir, env);
    await runGit(["commit", "-m", commitMessage], workdir, env);
    await runGit(["push", "--set-upstream", "origin", branch], workdir, env);
    const sha = (await runGit(["rev-parse", "HEAD"], workdir, env)).trim();
    return { commitSha: sha };
  }

  // -------------------------------------------------------------------------
  // Mappers
  // -------------------------------------------------------------------------

  private toPullRequest(raw: unknown, repo: RepoRef): PullRequest {
    const p = BbPR.parse(raw);
    const self = p.links?.self?.[0]?.href ?? "";
    const state = p.state.toLowerCase();
    return {
      repo,
      id: p.id,
      title: p.title,
      description: p.description,
      source: p.fromRef.displayId,
      target: p.toRef.displayId,
      state:
        state === "open" || state === "merged" || state === "declined" || state === "superseded"
          ? (state as PullRequest["state"])
          : "unknown",
      author: p.author?.user
        ? {
            name: p.author.user.displayName ?? p.author.user.name,
            email: p.author.user.emailAddress,
          }
        : undefined,
      webUrl: self,
      createdAt: p.createdDate ? new Date(p.createdDate).toISOString() : new Date().toISOString(),
      updatedAt: p.updatedDate ? new Date(p.updatedDate).toISOString() : new Date().toISOString(),
    };
  }

  private toComment(raw: unknown): PullRequestComment {
    const c = BbComment.parse(raw);
    return {
      id: c.id,
      text: c.text,
      author: c.author
        ? { name: c.author.displayName ?? c.author.name, email: c.author.emailAddress }
        : undefined,
      createdAt: c.createdDate ? new Date(c.createdDate).toISOString() : new Date().toISOString(),
    };
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function runGit(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else
        reject(
          new Error(`git ${args.join(" ")} exited ${code}: ${stderr.trim() || stdout.trim()}`),
        );
    });
  });
}

function errMsg(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    const data = err.response?.data;
    return `${status ?? "?"} ${typeof data === "string" ? data : JSON.stringify(data ?? err.message)}`;
  }
  return err instanceof Error ? err.message : String(err);
}
