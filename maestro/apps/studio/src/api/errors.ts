/**
 * The BFF never sends prose. Its failure body is flat: `{ error: "<code>" }`
 * plus an optional `details` object (apps/bff/src/server.ts). The `code` is a
 * stable machine identifier, so the Studio maps it to a catalog key and renders
 * the translated sentence. Raw server text is never printed to the user — there
 * is none to print, and that is the design we must not regress.
 */
export class ApiError extends Error {
  override readonly name = "ApiError";
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, details: unknown) {
    super(`api ${status} ${code}`);
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** Catalog key for this failure; see packages/config/locales/*.json. */
  get messageKey(): string {
    return errorMessageKey(this.code);
  }
}

/** Raised when the network never produced an HTTP response. */
export class NetworkError extends Error {
  override readonly name = "NetworkError";
  readonly messageKey = "error.network";
  constructor(override readonly cause: unknown) {
    super("network request failed");
  }
}

/** Raised when the session is gone; the app routes to /login. */
export class UnauthenticatedError extends ApiError {
  constructor(code: string, details: unknown) {
    super(401, code, details);
  }
}

/**
 * Every code the BFF can emit, mapped to a catalog key. Codes absent from this
 * table fall back to `error.unexpected` — a generic translated sentence, never
 * the raw code. Keep in sync with apps/bff/src/errors.ts call sites; a new BFF
 * code without an entry here is a bug caught by test/api-client.test.ts.
 */
const ERROR_KEYS: Readonly<Record<string, string>> = {
  // 401
  unauthenticated: "error.unauthenticated",
  session_expired: "error.session_expired",
  invalid_credentials: "error.invalid_credentials",
  // 400
  invalid_login_body: "error.invalid_login_body",
  invalid_query: "error.invalid_query",
  invalid_ticket_key: "error.invalid_ticket_key",
  invalid_signal_body: "error.invalid_signal_body",
  reject_needs_reason: "error.reject_needs_reason",
  invalid_param_key: "error.invalid_param_key",
  invalid_param_body: "error.invalid_param_body",
  param_value: "error.param_value",
  invalid_killswitch_body: "error.invalid_killswitch_body",
  ticket_key: "error.invalid_ticket_key",
  bad_request: "error.bad_request",
  // 403
  role_required: "error.role_required",
  project_access: "error.project_access",
  human_channel_only: "error.human_channel_only",
  not_gate_owner: "error.not_gate_owner",
  signal_not_allowed: "error.signal_not_allowed",
  forbidden: "error.forbidden",
  // 404
  no_run: "error.no_run",
  unknown_param: "error.unknown_param",
  not_found: "error.not_found",
  // 409
  no_open_gate: "error.no_open_gate",
  not_delivered: "error.not_delivered",
  param_value_mismatch: "error.param_value_mismatch",
  conflict: "error.conflict",
  // 500
  internal_error: "error.internal_error",
  /**
   * 503 — the route exists, the capability behind it does not.
   *
   * Distinct from 404 on purpose. `MaybeUnwired` reads a 404 as "this screen is
   * not published yet", which is the wrong sentence for `/eval`, `/cache` and
   * `/greenfield`: those endpoints ARE published and answer honestly that
   * nothing writes the data they would read. Without this line the screen falls
   * back to the generic `error.unexpected` and the distinction is lost on the
   * one person it was made for.
   */
  capability_not_wired: "error.capability_not_wired",
};

export function errorMessageKey(code: string): string {
  return ERROR_KEYS[code] ?? "error.unexpected";
}

export function knownErrorCodes(): readonly string[] {
  return Object.keys(ERROR_KEYS);
}

/** The catalog key for any thrown value, so toasts never print raw text. */
export function messageKeyOf(error: unknown): string {
  if (error instanceof ApiError) return error.messageKey;
  if (error instanceof NetworkError) return error.messageKey;
  return "error.unexpected";
}
