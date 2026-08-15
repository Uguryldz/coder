import type { CiPort, ScanPort, ScmPort } from "@maestro/ports";

/**
 * The ports the analysis-only release does not serve: scm, ci and scan.
 *
 * This release delivers a ticket's analysis: intake, the analysis document,
 * the human gate, delivery. Writing code, opening a pull request and merging
 * it are in the workflow but not in the release, and their ports need SOME
 * driver — `assertProfileComplete` rejects a profile with a hole in it before
 * a connection opens (M6).
 *
 * A driver that refuses is the honest filler. The alternative was to name a
 * real Azure DevOps driver and demand `ADO_BASE_URL` from an operator who has
 * no Azure DevOps: the deployment would then fail at boot over a port nothing
 * in this release calls. What these give instead is a deployment that runs the
 * analysis line end to end and answers any attempt to reach the engineering
 * line with a sentence saying so.
 *
 * The same reasoning as `unbridgedScanRunner` in `boot.ts`, and the same shape:
 * reject with a named error, never resolve with an empty value. A stub that
 * answered `{ prId: 0 }` would let a workflow believe it had opened a pull
 * request.
 */

const WHY_SCM =
  "scm: bu sürüm analiz hattını çalıştırır; kod yazma, PR açma ve merge kapsam dışıdır. " +
  "Kod hattını açmak için MAESTRO_PROFILE'ı scm/ci sürücüsü tanımlı bir profile alın (prod: ado).";

const WHY_CI =
  "ci: bu sürüm analiz hattını çalıştırır; build doğrulaması kapsam dışıdır. " +
  "Kod hattını açmak için MAESTRO_PROFILE'ı scm/ci sürücüsü tanımlı bir profile alın (prod: ado).";

/** Every method rejects; nothing resolves with an invented value. */
export function unavailableScmPort(): ScmPort {
  const refuse = (): Promise<never> => Promise.reject(new Error(WHY_SCM));
  return {
    resolveRepo: refuse,
    createBranch: refuse,
    getPushCredential: refuse,
    openPr: refuse,
    activatePr: refuse,
    listPrThreads: refuse,
    replyThread: refuse,
    getPrStatus: refuse,
    deleteBranch: refuse,
    getCommitChecks: refuse,
    mergePr: refuse,
  };
}

/**
 * The CI port's one method.
 *
 * `parseBuildEvent` may legitimately answer `null` — "this webhook is not a
 * build result" — so refusing here is a deliberate choice rather than a
 * transcription of the interface: a deployment that does not run builds should
 * not be receiving build webhooks, and answering `null` would make a
 * misrouted CI hook look like an ordinary uninteresting one.
 */
export function unavailableCiPort(): CiPort {
  return {
    parseBuildEvent: () => Promise.reject(new Error(WHY_CI)),
  };
}

/**
 * Scanning reads a diff, so it belongs to the engineering turn.
 *
 * Rejecting rather than answering "no findings" is the point: a scan port that
 * resolved with an empty result would let a gate that blocks on findings pass
 * on a repository nobody scanned (M27).
 */
export function unavailableScanPort(): ScanPort {
  return {
    run: () =>
      Promise.reject(
        new Error(
          "scan: bu sürüm analiz hattını çalıştırır; kod taraması kapsam dışıdır. " +
            "Boş sonuç DÖNDÜRÜLMEZ — taranmamış bir depo 'bulgu yok' olarak okunamaz (M27).",
        ),
      ),
  };
}
