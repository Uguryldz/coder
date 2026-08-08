import { assertNoPii, createSession, maskValue, unmaskValue, type MaskSession } from "./mask.js";
import { compileProfile, resolveProfile } from "./policy.js";
import type { ReverseMap } from "./reverse-map.js";
import type { DataClassName, MaskCounts, PiiPolicy } from "./types.js";

declare const MASKED_BRAND: unique symbol;

/**
 * A payload that has been through the boundary.
 *
 * The brand is unforgeable outside this module, so an outbound function typed
 * `(payload: Masked<Request>) => ...` simply cannot be handed a raw request:
 * the compiler rejects it. This is the type-level half of the fix for v1's
 * fatal defect — v1 had a working masker that the runner never called, and
 * nothing in the type system noticed.
 */
export type Masked<T> = T & { readonly [MASKED_BRAND]: "pii-masked" };

/** The only shape an egress function may take. */
export type OutboundCall<TIn, TOut> = (payload: Masked<TIn>) => Promise<TOut>;

export interface PiiBoundaryOptions {
  readonly policy: PiiPolicy;
  /**
   * Declared data class. Deliberately `unknown`: webhooks and Jira fields
   * hand us whatever they like, and an unrecognised value must land on the
   * strictest profile rather than throw (M18/M63 fail-closed).
   */
  readonly dataClass: unknown;
  /** Name used in leak errors and audit rows. */
  readonly boundary?: string;
  /** Audit hook (M33 `PII_MASKED`). Receives counts — never values. */
  readonly onMasked?: (counts: MaskCounts, dataClass: DataClassName) => void;
}

export interface MaskOutboundResult<T> {
  readonly payload: Masked<T>;
  /**
   * Session map. Hold it only for as long as the matching response needs
   * un-masking and never put it in a log, an artifact or a request body.
   */
  readonly map: ReverseMap;
  readonly counts: MaskCounts;
  readonly dataClass: DataClassName;
}

export interface PiiBoundaryResult<TOut> {
  /** Tokens replaced by real values — for the human on the other end only. */
  readonly output: TOut;
  /** Tokens intact — this is the copy that may be persisted (M20/M82). */
  readonly maskedOutput: TOut;
  readonly counts: MaskCounts;
  readonly dataClass: DataClassName;
}

function prepare(options: PiiBoundaryOptions): {
  session: MaskSession;
  dataClass: DataClassName;
} {
  const resolved = resolveProfile(options.policy, options.dataClass);
  return { session: createSession(resolved.profile), dataClass: resolved.dataClass };
}

/**
 * Low-level half of the gate. Prefer `withPiiBoundary`, which cannot be
 * half-used; reach for this pair only when request and response are handled
 * by different call frames (a queued gateway call, for instance).
 */
export function maskOutbound<T>(payload: T, options: PiiBoundaryOptions): MaskOutboundResult<T> {
  const { session, dataClass } = prepare(options);
  const masked = maskValue(payload, session);
  options.onMasked?.(masked.counts, dataClass);
  assertNoPii(masked.value, session.profile, options.boundary ?? "outbound");
  return {
    payload: masked.value as Masked<T>,
    map: session.map,
    counts: masked.counts,
    dataClass,
  };
}

/** The other half: put the session's values back into what came back. */
export function unmaskInbound<T>(value: T, map: ReverseMap): T {
  return unmaskValue(value, map);
}

/**
 * The gate. Wrap the outbound call once and masking stops being something a
 * caller can forget: the wrapper masks, trips the runtime guard, calls, and
 * un-masks the answer. The ReverseMap is created and dropped inside this
 * frame, so it cannot be logged or persisted by anyone downstream.
 */
export function withPiiBoundary<TIn, TOut>(
  options: PiiBoundaryOptions,
  call: OutboundCall<TIn, TOut>,
): (payload: TIn) => Promise<PiiBoundaryResult<TOut>> {
  const boundary = options.boundary ?? "outbound";
  return async (payload: TIn): Promise<PiiBoundaryResult<TOut>> => {
    const { session, dataClass } = prepare(options);
    const masked = maskValue(payload, session);
    options.onMasked?.(masked.counts, dataClass);
    assertNoPii(masked.value, session.profile, boundary);
    const maskedOutput = await call(masked.value as Masked<TIn>);
    return {
      output: unmaskValue(maskedOutput, session.map),
      maskedOutput,
      counts: masked.counts,
      dataClass,
    };
  };
}

/**
 * Runtime half of the fix, for egress points that are not called through
 * `withPiiBoundary` (a storage writer, a notifier). A caller that casts its
 * way past `Masked<T>` still gets a `PiiLeakError` rather than a disclosure.
 */
export function guardEgress<TIn, TOut>(
  options: PiiBoundaryOptions,
  send: OutboundCall<TIn, TOut>,
): OutboundCall<TIn, TOut> {
  const boundary = options.boundary ?? "outbound";
  return async (payload: Masked<TIn>): Promise<TOut> => {
    const { profile } = resolveProfile(options.policy, options.dataClass);
    assertNoPii(payload, compileProfile(profile), boundary);
    return send(payload);
  };
}
