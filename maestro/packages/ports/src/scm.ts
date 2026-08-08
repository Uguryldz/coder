import type { ApplicationRecord, GitSha } from "@maestro/contracts";

export interface RepoRef {
  project: string;
  repo: string;
}

export interface PrThread {
  threadId: number;
  status: "active" | "fixed" | "closed";
  comments: Array<{ author: string; text: string; at: string }>;
}

export interface PrStatus {
  prId: number;
  state: "draft" | "active" | "completed" | "abandoned";
  mergeSha: GitSha | null;
}

/** SCM port — Azure DevOps dual-mode driver (Server + Services, M11). */
export interface ScmPort {
  resolveRepo(app: ApplicationRecord): Promise<RepoRef>;
  createBranch(repo: RepoRef, name: string, fromRef: string): Promise<void>;
  /** Short-lived push credential for the runner (M31/M80). */
  getPushCredential(repo: RepoRef, ttlSeconds: number): Promise<{ token: string; expiresAt: string }>;
  openPr(
    repo: RepoRef,
    args: { sourceBranch: string; targetBranch: string; title: string; description: string; draft: boolean },
  ): Promise<{ prId: number }>;
  activatePr(repo: RepoRef, prId: number): Promise<void>;
  listPrThreads(repo: RepoRef, prId: number): Promise<PrThread[]>;
  replyThread(repo: RepoRef, prId: number, threadId: number, text: string): Promise<void>;
  getPrStatus(repo: RepoRef, prId: number): Promise<PrStatus>;
}
