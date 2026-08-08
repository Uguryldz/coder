/** Base class so a composition root can catch everything this package throws. */
export class ExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionError";
  }
}

/** The CLI ran but did not speak the protocol we parse. Never downgraded to
 * "empty answer": a turn we cannot read is one we can prove nothing about. */
export class ClaudeCliProtocolError extends ExecutionError {
  constructor(message: string) {
    super(`claude CLI stream protocol: ${message}`);
    this.name = "ClaudeCliProtocolError";
  }
}

/** The CLI exited non-zero, or reported `is_error` in its result message. */
export class ClaudeCliError extends ExecutionError {
  constructor(
    message: string,
    readonly exitCode: number,
    readonly stderrTail: string,
  ) {
    super(message);
    this.name = "ClaudeCliError";
  }
}

/** Misconfiguration of the runner itself (bad flag values, missing binary path). */
export class ExecutionConfigError extends ExecutionError {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionConfigError";
  }
}

/** M52: carries the offending paths so a handover names files, not "policy". */
export class ProtectedPathViolationError extends ExecutionError {
  constructor(readonly violations: readonly string[]) {
    super(`protected paths changed by the agent session: ${violations.join(", ")}`);
    this.name = "ProtectedPathViolationError";
  }
}

/** The workspace could not be inspected, so "nothing was touched" is unprovable. */
export class WorkspaceProbeError extends ExecutionError {
  constructor(workspacePath: string, cause: string) {
    super(`workspace ${workspacePath} could not be inspected (${cause}); protected-path enforcement cannot be proven`);
    this.name = "WorkspaceProbeError";
  }
}
