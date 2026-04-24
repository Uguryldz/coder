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
 * GitLab adapter — stub. Targeted for v1.1.
 */
export class GitLabClient implements GitClient {
  readonly platform = "gitlab" as const;

  async getRepo(_projectKey: string, _repoSlug: string): Promise<Repo> {
    throw new NotImplementedError("GitLabClient.getRepo");
  }
  async getBranch(_repo: RepoRef, _branchName: string): Promise<Branch> {
    throw new NotImplementedError("GitLabClient.getBranch");
  }
  async createBranch(_repo: RepoRef, _branchName: string, _fromCommit: string): Promise<Branch> {
    throw new NotImplementedError("GitLabClient.createBranch");
  }
  async createPullRequest(_params: CreatePullRequestParams): Promise<PullRequest> {
    throw new NotImplementedError("GitLabClient.createPullRequest");
  }
  async getPullRequest(_pr: PullRequestRef): Promise<PullRequest> {
    throw new NotImplementedError("GitLabClient.getPullRequest");
  }
  async addPullRequestComment(_pr: PullRequestRef, _text: string): Promise<PullRequestComment> {
    throw new NotImplementedError("GitLabClient.addPullRequestComment");
  }
  async listPullRequestComments(_pr: PullRequestRef): Promise<PullRequestComment[]> {
    throw new NotImplementedError("GitLabClient.listPullRequestComments");
  }
  async getPullRequestActivity(_pr: PullRequestRef): Promise<PullRequestActivity[]> {
    throw new NotImplementedError("GitLabClient.getPullRequestActivity");
  }
  async pushChanges(_params: PushChangesParams): Promise<{ commitSha: string }> {
    throw new NotImplementedError("GitLabClient.pushChanges");
  }
  async setBranchRestriction(
    _repo: RepoRef,
    _pattern: string,
    _opts?: { fastForward?: boolean; noForcePush?: boolean },
  ): Promise<void> {
    throw new NotImplementedError("GitLabClient.setBranchRestriction");
  }
}
