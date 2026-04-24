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
import { NotImplementedError } from "./index.js";

/**
 * GitHub adapter — stub. Targeted for v1.1.
 *
 * The shape matches `GitClient` so workflow code compiles against it; every
 * method throws `NotImplementedError` at runtime.
 */
export class GitHubClient implements GitClient {
  readonly platform = "github" as const;

  async getRepo(_projectKey: string, _repoSlug: string): Promise<Repo> {
    throw new NotImplementedError("GitHubClient.getRepo");
  }
  async getBranch(_repo: RepoRef, _branchName: string): Promise<Branch> {
    throw new NotImplementedError("GitHubClient.getBranch");
  }
  async createBranch(_repo: RepoRef, _branchName: string, _fromCommit: string): Promise<Branch> {
    throw new NotImplementedError("GitHubClient.createBranch");
  }
  async createPullRequest(_params: CreatePullRequestParams): Promise<PullRequest> {
    throw new NotImplementedError("GitHubClient.createPullRequest");
  }
  async getPullRequest(_pr: PullRequestRef): Promise<PullRequest> {
    throw new NotImplementedError("GitHubClient.getPullRequest");
  }
  async addPullRequestComment(_pr: PullRequestRef, _text: string): Promise<PullRequestComment> {
    throw new NotImplementedError("GitHubClient.addPullRequestComment");
  }
  async listPullRequestComments(_pr: PullRequestRef): Promise<PullRequestComment[]> {
    throw new NotImplementedError("GitHubClient.listPullRequestComments");
  }
  async getPullRequestActivity(_pr: PullRequestRef): Promise<PullRequestActivity[]> {
    throw new NotImplementedError("GitHubClient.getPullRequestActivity");
  }
  async pushChanges(_params: PushChangesParams): Promise<{ commitSha: string }> {
    throw new NotImplementedError("GitHubClient.pushChanges");
  }
  async setBranchRestriction(
    _repo: RepoRef,
    _pattern: string,
    _opts?: { fastForward?: boolean; noForcePush?: boolean },
  ): Promise<void> {
    throw new NotImplementedError("GitHubClient.setBranchRestriction");
  }
}
