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

/**
 * The aggregate CI verdict for a commit (B14). `pending` means at least one
 * required check is still running (or none has reported yet); `success` means
 * every completed check passed; `failure` means at least one failed. `none`
 * means the commit has no checks at all — a repo without CI configured, which a
 * caller may treat as "nothing to wait for" rather than red.
 */
export interface CommitChecks {
  sha: GitSha;
  state: "pending" | "success" | "failure" | "none";
  /** Human-readable per-check lines for the log ("build ✓", "e2e ✗"). */
  detail: string[];
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
  /**
   * Delete a branch after its PR is merged, so merged feature branches do not
   * pile up. OPTIONAL capability: a driver that cannot (or a deployment that
   * relies on GitHub's auto-delete-on-merge) simply omits it, and the caller
   * skips branch tidy-up. Adding it as optional keeps every existing ScmPort
   * implementation valid without change.
   */
  deleteBranch?(repo: RepoRef, name: string): Promise<void>;
  /**
   * ÇALIŞMA ALANINI VAR ET — klon diskte yoksa yeniden aç.
   *
   * Klon bir dönem YALNIZCA koşu başlarken açılıyordu ve bu, klonun koşu
   * boyunca yerinde DURDUĞU varsayımına dayanıyordu. Varsayım sahada
   * yıkıldı: `/workspace` bir tmpfs birimidir (compose, `maestro-workspace`)
   * ve konteyner her yeniden başladığında SİLİNİR. Bir sürüm yükseltmesi,
   * bir çökme, bir `docker compose up` yeter.
   *
   * O zaman koşu satırı hâlâ bir yol taşır (`workspacePath` dolu,
   * `workspacePresent: true`) ama dizin YOKTUR. Keşif adımı yalnız yolun boş
   * olup olmadığına baktığı için farkı göremez; ajan oturumu var olmayan bir
   * dizinde açılır ve künye "okunamadı" der. Operatörün gördüğü tek şey
   * "analiz ticket metninden üretildi, kod karşılığı yok" olur — sebebi
   * söyleyen tek satır olmadan.
   *
   * Bu yetenek o boşluğu kapatır: adım kodu okumadan ÖNCE çalışma alanının
   * gerçekten yerinde olduğunu sorar, değilse yeniden klonlanır. OPSİYONEL,
   * çünkü klonlamayan bir sürücü (sahte ADO) bunu sunmaz ve çağıran eski
   * davranışa düşer.
   *
   * Dönen değer klonun yolu, ya da açılamadıysa `null`.
   */
  ensureWorkspace?(request: {
    readonly runId: string;
    readonly appId: string;
    readonly targetBranch?: string | null;
  }): Promise<string | null>;
  /**
   * Read the aggregate CI verdict for a commit (B14 — real GitHub Checks/commit
   * status). OPTIONAL: a driver with no real CI (the fake ADO prop) omits it and
   * the caller falls back to its existing signal. Adding it as optional keeps
   * every existing ScmPort implementation valid without change.
   */
  getCommitChecks?(repo: RepoRef, sha: GitSha): Promise<CommitChecks>;
  /**
   * Merge a pull request (B14 — real merge). OPTIONAL and deliberately guarded
   * by the caller: the pilot's DEFAULT stays human-merge, and this is invoked
   * only when auto-merge is explicitly enabled AND the gate approved AND CI is
   * green. Returns the merge commit sha. A driver that cannot merge omits it.
   */
  mergePr?(repo: RepoRef, prId: number): Promise<{ mergeSha: GitSha }>;
}
