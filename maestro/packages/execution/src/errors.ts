/** Base class so a composition root can catch everything this package throws. */
export class ExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionError";
  }
}

/** Misconfiguration of the runner itself (bad pattern, bad limit). */
export class ExecutionConfigError extends ExecutionError {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionConfigError";
  }
}

/**
 * A run's declared data class changed between two turns. Fail-closed and loud:
 * the journal writer holds ONE masking session per run, so a mid-run change
 * would either re-tokenise text the journal already recorded (turn 1's
 * `[IBAN_1.a3f9]` losing its brackets) or keep masking a now-stricter run with
 * the looser profile. Neither is recoverable after the fact.
 */
export class DataClassChangedError extends ExecutionError {
  constructor(runId: string, from: string, to: string) {
    super(`run ${runId} was journalled as data class "${from}" and this turn declares "${to}"`);
    this.name = "DataClassChangedError";
  }
}

/** The workspace could not be inspected, so "nothing was touched" is unprovable. */
export class WorkspaceProbeError extends ExecutionError {
  constructor(workspacePath: string, cause: string) {
    super(`workspace ${workspacePath} could not be inspected (${cause}); protected-path enforcement cannot be proven`);
    this.name = "WorkspaceProbeError";
  }
}
