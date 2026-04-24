/**
 * @orkestra/git — Generic Git platform abstraction.
 *
 * v1.0 ships Bitbucket DC as the primary adapter. GitHub / GitLab adapters
 * are stubbed so workflows can be ported without rewrites.
 */
import { createLogger } from "@orkestra/config";
import { BitbucketClient } from "./bitbucket.js";
import { GitHubClient } from "./github.js";
import { GitLabClient } from "./gitlab.js";

const log = createLogger("git.factory");

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface RepoRef {
  /** Bitbucket "project key" / GitHub-GitLab "owner". */
  projectKey: string;
  /** Repo slug. */
  repoSlug: string;
}

export interface Repo extends RepoRef {
  id: string | number;
  name: string;
  defaultBranch?: string;
  cloneUrl: string;
  webUrl: string;
}

export interface Branch {
  name: string;
  commitId: string;
}

export interface PullRequestRef {
  repo: RepoRef;
  id: number;
}

export interface PullRequest extends PullRequestRef {
  title: string;
  description: string;
  source: string;
  target: string;
  state: "open" | "merged" | "declined" | "superseded" | "unknown";
  author?: { name?: string; email?: string };
  webUrl: string;
  createdAt: string;
  updatedAt: string;
}

export interface PullRequestComment {
  id: number | string;
  text: string;
  author?: { name?: string; email?: string };
  createdAt: string;
}

export interface PullRequestActivity {
  id: number | string;
  action: string;
  createdAt: string;
  raw: unknown;
}

export interface CreatePullRequestParams {
  repo: RepoRef;
  source: string;
  target: string;
  title: string;
  description: string;
  reviewers?: Array<{ name: string }>;
}

export interface PushChangesParams {
  repo: RepoRef;
  /** Absolute path inside the sandbox where the repo is checked out. */
  workdir: string;
  branch: string;
  commitMessage: string;
  authorName?: string;
  authorEmail?: string;
  /** Files (relative to workdir) to stage. `["."]` stages everything. */
  filesToAdd?: string[];
}

export interface GitClient {
  readonly platform: "bitbucket" | "github" | "gitlab";

  getRepo(projectKey: string, repoSlug: string): Promise<Repo>;
  getBranch(repo: RepoRef, branchName: string): Promise<Branch>;
  createBranch(repo: RepoRef, branchName: string, fromCommit: string): Promise<Branch>;

  createPullRequest(params: CreatePullRequestParams): Promise<PullRequest>;
  getPullRequest(pr: PullRequestRef): Promise<PullRequest>;
  addPullRequestComment(pr: PullRequestRef, text: string): Promise<PullRequestComment>;
  listPullRequestComments(pr: PullRequestRef): Promise<PullRequestComment[]>;
  getPullRequestActivity(pr: PullRequestRef): Promise<PullRequestActivity[]>;

  /**
   * Push local changes to a branch. This is implemented via shelling out to
   * `git` inside the sandbox — repository writes do NOT go through REST.
   */
  pushChanges(params: PushChangesParams): Promise<{ commitSha: string }>;

  /**
   * Set branch-level protection: disallow force push, require fast-forward.
   */
  setBranchRestriction(
    repo: RepoRef,
    pattern: string,
    opts?: { fastForward?: boolean; noForcePush?: boolean },
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`[git] not implemented: ${what}`);
    this.name = "NotImplementedError";
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export type GitPlatform = "bitbucket" | "github" | "gitlab" | "gitea";

export interface GitClientOptions {
  platform?: GitPlatform;
  baseUrl?: string;
  username?: string;
  appPassword?: string;
  timeoutMs?: number;
}

/**
 * Return the configured Git client. Defaults to Bitbucket DC.
 * Gitea is wire-compatible with Bitbucket DC for core endpoints, so it uses
 * the Bitbucket adapter (same path layout: /rest/api/1.0/...).
 */
export function getGitClient(opts: GitClientOptions = {}): GitClient {
  const platform = opts.platform ?? "bitbucket";
  const commonOpts = {
    baseUrl: opts.baseUrl,
    username: opts.username,
    appPassword: opts.appPassword,
    timeoutMs: opts.timeoutMs,
  };
  switch (platform) {
    case "bitbucket":
    case "gitea":
      return new BitbucketClient(commonOpts);
    case "github":
      log.warn("github adapter is a stub — calls will throw");
      return new GitHubClient();
    case "gitlab":
      log.warn("gitlab adapter is a stub — calls will throw");
      return new GitLabClient();
    default: {
      const _exhaustive: never = platform;
      throw new Error(`[git] unknown platform: ${String(_exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export { BitbucketClient } from "./bitbucket.js";
export { GitHubClient } from "./github.js";
export { GitLabClient } from "./gitlab.js";

export { parseBitbucketPullRequestEvent, verifyBitbucketWebhook } from "./webhook.js";
export type {
  BitbucketPipelineEvent,
  BitbucketPRCommentEvent,
  BitbucketPREvent,
  BitbucketPushEvent,
  BitbucketWebhookEvent,
} from "./webhook.js";
