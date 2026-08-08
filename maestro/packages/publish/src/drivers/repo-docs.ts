import { z } from "zod";
import { NonEmpty, type PublishReceipt, type PublishRequest, type PublishTarget } from "@maestro/contracts";
import type { ScmPort } from "@maestro/ports";
import { PublishConfigError } from "../errors.js";
import { contentHash } from "../md.js";
import type { PublishStateStore, RepoWorkspace, RunContextResolver, TargetPublisher } from "../types.js";

const PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** `docs/../../etc` matches the charset but escapes the repository. */
const RepoPath = z
  .string()
  .regex(PATH_SEGMENT)
  .refine((value) => !value.split("/").includes(".."), { message: "must not contain a `..` segment" });

export const RepoDocsPublishConfig = z
  .object({
    /** Directory inside the application's repo, e.g. `docs/maestro`. */
    docsDir: RepoPath.default("docs/maestro"),
    baseBranch: NonEmpty.default("main"),
    branchPrefix: RepoPath.default("docs/maestro"),
    /** Documents land through review by default (M49 trunk-based). */
    openPullRequest: z.boolean().default(true),
  })
  .strict();
export type RepoDocsPublishConfig = z.infer<typeof RepoDocsPublishConfig>;

const RepoDocsState = z.object({
  branch: z.string().min(1),
  path: z.string().min(1),
  hash: z.string().min(1),
  sha: z.string().min(1).nullable(),
  prId: z.number().int().positive().optional(),
});

export interface RepoDocsPublisherDeps {
  scm: ScmPort;
  workspace: RepoWorkspace;
  state: PublishStateStore;
  runContext: RunContextResolver;
}

/**
 * repo-docs driver (M47): the document is written into the application's own
 * repository and delivered as a commit (plus a PR by default). No git client
 * here (M44) — `ScmPort` does branch/PR, the injected workspace does the file.
 *
 * Idempotent by content: if the file on the branch already holds these exact
 * bytes, nothing is committed. Republishing an unchanged document produces no
 * empty commit and no second PR.
 *
 * Commit message, branch name and PR title stay ENGLISH (M59) even when the
 * document body is Turkish.
 */
export class RepoDocsPublisher implements TargetPublisher {
  readonly target: PublishTarget = "repo-docs";

  constructor(
    private readonly config: RepoDocsPublishConfig,
    private readonly deps: RepoDocsPublisherDeps,
  ) {
    if (typeof deps.scm?.resolveRepo !== "function") {
      throw new PublishConfigError("the repo-docs target needs deps.scm (ScmPort)");
    }
    if (typeof deps.workspace?.commitFile !== "function") {
      throw new PublishConfigError("the repo-docs target needs deps.workspace (RepoWorkspace)");
    }
  }

  async publish(req: PublishRequest, markdownSource: string): Promise<PublishReceipt> {
    const { ticketKey, app } = await this.deps.runContext(req.runId);
    if (!app) {
      throw new PublishConfigError(`run ${req.runId} has no application — repo-docs has no repository to write to`);
    }

    const stateKey = `publish:repo-docs:${req.runId}:${req.doc}`;
    const previous = await this.readState(stateKey);
    const hash = contentHash(markdownSource);
    if (previous && previous.hash === hash && previous.sha) {
      return { target: this.target, ref: previous.sha };
    }

    const path = `${this.config.docsDir}/${ticketKey}/${req.doc}.md`;
    const branch = previous?.branch ?? `${this.config.branchPrefix}/${ticketKey}-${req.doc}`;
    const repo = await this.deps.scm.resolveRepo(app);

    const existing = await this.deps.workspace.readFile(branch, path);
    if (existing === null && !previous) {
      await this.deps.scm.createBranch(repo, branch, this.config.baseBranch);
    }

    let sha = previous?.sha ?? null;
    if (existing !== markdownSource) {
      const committed = await this.deps.workspace.commitFile({
        branch,
        path,
        content: markdownSource,
        message: `docs(maestro): ${req.doc.replace(/_/g, " ")} for ${ticketKey}`,
      });
      if (typeof committed?.sha !== "string" || committed.sha.trim().length === 0) {
        throw new PublishConfigError("RepoWorkspace.commitFile returned an empty commit sha");
      }
      sha = committed.sha;
    }

    let prId = previous?.prId;
    if (this.config.openPullRequest && prId === undefined) {
      const opened = await this.deps.scm.openPr(repo, {
        sourceBranch: branch,
        targetBranch: this.config.baseBranch,
        title: `docs(maestro): ${req.doc.replace(/_/g, " ")} for ${ticketKey}`,
        description: `Automated document publication for ${ticketKey} (run ${req.runId}). File: ${path}`,
        draft: false,
      });
      prId = opened.prId;
    }

    await this.deps.state.set(
      stateKey,
      JSON.stringify({ branch, path, hash, sha, ...(prId === undefined ? {} : { prId }) }),
    );
    // A run whose bookkeeping was lost re-publishes identical bytes: there is
    // no commit to point at, so the receipt carries the file path instead
    // (both are legal `PublishReceipt.ref` values).
    return { target: this.target, ref: sha ?? path };
  }

  private async readState(key: string): Promise<z.infer<typeof RepoDocsState> | null> {
    const raw = await this.deps.state.get(key);
    if (raw === null) return null;
    try {
      const parsed = RepoDocsState.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }
}
