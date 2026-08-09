import type { CoreDeps } from "@maestro/workflows";

/**
 * The doing-role turn runner, unfilled — deliberately, and loudly.
 *
 * `AgentExecution` (`@maestro/execution`) is the real implementation, and it
 * is NOT a store: it needs a `WorkspaceProbe`, a `VerificationRunner` and a
 * `StrikeLedger`, which are runner-fleet collaborators over a sandbox. None of
 * the three has an implementation in the tree yet, and none of them is
 * Postgres-backed run state, so none of them was part of the store work that
 * unblocked this worker.
 *
 * This follows the same rule as `unbridgedScanRunner` in `boot.ts`: the seam
 * COMPOSES so the deployment can prove its wiring and every other activity
 * runs, and it fails at the first engineering turn with a message naming the
 * missing piece — rather than an adapter that pretends.
 *
 * Refusing here is narrower than refusing to start. Intake, analysis, the
 * gates, the escalation ladder, notification and publication all work; only
 * the turn that would write code stops. A worker that refused to boot over
 * this would also refuse to run the twelve steps that need nothing from it.
 */
export function unwiredAgentTurnRunner(): CoreDeps["execution"] {
  return {
    runTurn: () =>
      Promise.reject(
        new Error(
          "execution: no AgentTurnRunner is wired. `AgentExecution` needs a WorkspaceProbe, a " +
            "VerificationRunner and a StrikeLedger over the runner fleet, and none of the three " +
            "is implemented yet (M30/M52/M54). See ARAYÜZ İSTEĞİ in packages/db/RAPOR-dalga5.md.",
        ),
      ),
    /**
     * A no-op rather than a throw. `endRun` is cleanup — the workflow calls it
     * on the way out of a run, including a run that failed BECAUSE `runTurn`
     * refused. Throwing here would replace that failure's message with this
     * one and hide why the run actually stopped.
     */
    endRun: () => undefined,
  };
}
