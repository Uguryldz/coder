export class AgentDriverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentDriverError";
  }
}

/** The routed driver cannot carry tool calls, or is not an HTTP driver at all. */
export class AgentTransportError extends AgentDriverError {
  constructor(message: string) {
    super(message);
    this.name = "AgentTransportError";
  }
}

/** The session hit its step budget without the model answering. */
export class AgentStepBudgetError extends AgentDriverError {
  constructor(readonly steps: number) {
    super(`agent session used all ${String(steps)} tool steps without producing a final answer`);
    this.name = "AgentStepBudgetError";
  }
}
