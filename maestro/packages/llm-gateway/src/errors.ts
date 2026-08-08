/**
 * Typed gateway failures. Every mode the core branches on gets a class —
 * nobody string-matches a message to tell a policy block from an expired key.
 */
export class LlmGatewayError extends Error {}

/** Configuration or wiring is wrong — thrown at construction/first use. */
export class LlmConfigError extends LlmGatewayError {
  constructor(message: string) {
    super(`llm-gateway configuration error: ${message}`);
    this.name = "LlmConfigError";
  }
}

/** Any non-2xx provider response; `responseBody` is truncated for the audit trail (M33). */
export class LlmHttpError extends LlmGatewayError {
  constructor(
    readonly status: number,
    readonly driver: string,
    readonly url: string,
    readonly responseBody: string,
    message?: string,
  ) {
    super(message ?? `${driver} ${url} failed with HTTP ${status}`);
    this.name = "LlmHttpError";
  }
}

/** 401/403 — key missing, revoked or lacking the model entitlement. */
export class LlmAuthError extends LlmHttpError {
  constructor(status: number, driver: string, url: string, body: string) {
    super(status, driver, url, body, `${driver} ${url}: unauthorized (HTTP ${status})`);
    this.name = "LlmAuthError";
  }
}

/** 429 — still throttled after the configured retries. */
export class LlmRateLimitError extends LlmHttpError {
  constructor(driver: string, url: string, body: string, readonly retryAfterMs: number | null) {
    super(429, driver, url, body, `${driver} ${url}: rate limited`);
    this.name = "LlmRateLimitError";
  }
}

/** The provider answered 2xx with a body we cannot read. */
export class LlmResponseError extends LlmGatewayError {
  constructor(readonly driver: string, readonly issues: string[]) {
    super(`${driver}: unexpected response shape: ${issues.join("; ")}`);
    this.name = "LlmResponseError";
  }
}

/** Structured output failed the schema twice (initial + one repair round). */
export class LlmSchemaValidationError extends LlmGatewayError {
  constructor(readonly schemaName: string, readonly attempts: number, readonly issues: string[]) {
    super(`schema "${schemaName}" not satisfied after ${attempts} attempt(s): ${issues.join("; ")}`);
    this.name = "LlmSchemaValidationError";
  }
}

/** No binding for role/variant — M19: an unknown model is an error, never a silent fallback. */
export class UnknownModelError extends LlmGatewayError {
  constructor(readonly role: string, readonly variantId: string) {
    super(`no model binding for role "${role}" / variant "${variantId}"`);
    this.name = "UnknownModelError";
  }
}

/** M18: the data class policy forbids every candidate backend. `messageKey` is i18n (M104). */
export class LlmPolicyBlockedError extends LlmGatewayError {
  constructor(readonly dataClass: string, readonly messageKey: string) {
    super(`data class "${dataClass}" blocked by routing policy (${messageKey})`);
    this.name = "LlmPolicyBlockedError";
  }
}

/**
 * M55: the whole subscription pool is exhausted. The queue-aware entry points
 * RETURN this state; the frozen `LlmPort` methods throw it so `resumeAt`
 * still reaches the caller (see RAPOR.md request #1).
 */
export class SubscriptionQueuedError extends LlmGatewayError {
  constructor(readonly resumeAt: string, readonly messageKey: string) {
    super(`subscription pool exhausted; resume at ${resumeAt}`);
    this.name = "SubscriptionQueuedError";
  }
}

/** Agent execution is delegated (Wave 2); no runner was wired in. */
export class AgentRunnerNotWiredError extends LlmGatewayError {
  constructor() {
    super("agent session requested but no AgentRunner was injected (Wave 2 execution package)");
    this.name = "AgentRunnerNotWiredError";
  }
}

/** A resume token this gateway never issued — fail-closed, never a fresh session. */
export class UnknownResumeTokenError extends LlmGatewayError {
  constructor(readonly resumeToken: string) {
    super(`unknown resume token "${resumeToken}"`);
    this.name = "UnknownResumeTokenError";
  }
}
