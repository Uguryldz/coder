import { PiiLeakError } from "./errors.js";
import { assertNoPii, createSession, maskValue, unmaskValue, type MaskSession } from "./mask.js";
import { Masked, mintMasked } from "./masked.js";
import { resolveProfile, type CompiledProfile, type LoadedPiiPolicy } from "./policy.js";
import type { ReverseMap } from "./reverse-map.js";
import { PiiBoundaryResult } from "./result.js";
import type { DataClassName, MaskCounts } from "./types.js";

/** The only shape an egress function may take. */
export type OutboundCall<TIn, TOut> = (payload: Masked<TIn>) => Promise<TOut>;

/** Which leg of the exchange an audit line describes. */
export type MaskLeg = "request" | "response";

export interface MaskedInfo {
  readonly boundary: string;
  readonly leg: MaskLeg;
  /**
   * The declared data class was missing or unrecognised and the strictest
   * profile was used instead. This used to be computed and then dropped on
   * the floor, so a fail-closed fallback produced no audit signal at all.
   */
  readonly fellBack: boolean;
}

/** Audit hook (M33 `PII_MASKED`). Receives counts — never values. */
export type MaskedHook = (
  counts: MaskCounts,
  dataClass: DataClassName,
  info: MaskedInfo,
) => void;

export interface PiiBoundaryOptions {
  /**
   * A policy that went through `loadPiiPolicy`. Typed as the branded
   * `LoadedPiiPolicy` on purpose: a hand-written literal used to compile
   * here, which skipped every fail-closed rule loading applies (B-7).
   */
  readonly policy: LoadedPiiPolicy;
  /**
   * Declared data class. Deliberately `unknown`: webhooks and Jira fields
   * hand us whatever they like, and an unrecognised value must land on the
   * strictest profile rather than throw (M18/M63 fail-closed). It is also,
   * for the same reason, UNTRUSTED — see RAPOR §4.
   */
  readonly dataClass: unknown;
  /** Name used in leak errors and audit rows. */
  readonly boundary?: string;
  readonly onMasked?: MaskedHook;
}

export interface MaskOutboundResult<T> {
  /** The masked payload itself, for a caller that builds a request body. */
  readonly payload: T;
  /** The same payload sealed — the only thing `guardEgress` accepts. */
  readonly envelope: Masked<T>;
  /**
   * Session map. Hold it only for as long as the matching response needs
   * un-masking and never put it in a log, an artifact or a request body.
   */
  readonly map: ReverseMap;
  readonly counts: MaskCounts;
  readonly dataClass: DataClassName;
  readonly fellBack: boolean;
  /** The compiled profile that did the masking — hand this to `guardEgress`. */
  readonly profile: CompiledProfile;
}

export { PiiBoundaryResult } from "./result.js";

interface Prepared {
  readonly session: MaskSession;
  readonly dataClass: DataClassName;
  readonly fellBack: boolean;
}

function prepare(options: PiiBoundaryOptions): Prepared {
  const resolved = resolveProfile(options.policy, options.dataClass);
  return {
    session: createSession(resolved.profile),
    dataClass: resolved.dataClass,
    fellBack: resolved.fellBack,
  };
}

/**
 * Low-level half of the gate. Prefer `withPiiBoundary`, which cannot be
 * half-used; reach for this pair only when request and response are handled
 * by different call frames (a queued gateway call, for instance).
 */
export function maskOutbound<T>(payload: T, options: PiiBoundaryOptions): MaskOutboundResult<T> {
  const { session, dataClass, fellBack } = prepare(options);
  const boundary = options.boundary ?? "outbound";
  const masked = maskValue(payload, session);
  options.onMasked?.(masked.counts, dataClass, { boundary, leg: "request", fellBack });
  assertNoPii(masked.value, session.profile, boundary);
  return {
    payload: masked.value,
    envelope: mintMasked(masked.value),
    map: session.map,
    counts: masked.counts,
    dataClass,
    fellBack,
    profile: session.profile,
  };
}

/** The other half: put the session's values back into what came back. */
export function unmaskInbound<T>(value: T, map: ReverseMap): T {
  return unmaskValue(value, map);
}

/**
 * The gate. Wrap the outbound call once and masking stops being something a
 * caller can forget: the wrapper masks, trips the runtime guard, calls, masks
 * the answer as well, and only then un-masks a copy for the screen. The
 * ReverseMap is created and dropped inside this frame, so it cannot be logged
 * or persisted by anyone downstream.
 */
export function withPiiBoundary<TIn, TOut>(
  options: PiiBoundaryOptions,
  call: OutboundCall<TIn, TOut>,
): (payload: TIn) => Promise<PiiBoundaryResult<TOut>> {
  const boundary = options.boundary ?? "outbound";
  return async (payload: TIn): Promise<PiiBoundaryResult<TOut>> => {
    const { session, dataClass, fellBack } = prepare(options);
    const masked = maskValue(payload, session);
    options.onMasked?.(masked.counts, dataClass, { boundary, leg: "request", fellBack });
    assertNoPii(masked.value, session.profile, boundary);

    const answer = await call(mintMasked(masked.value));

    // The return leg is journalled for ten years (M82) and nothing used to
    // look at it: a model that writes an identifier out of its own context
    // put raw PII straight into the record (B-11). Masking it through the
    // same session keeps token identity stable across the exchange.
    const back = maskValue(answer, session);
    options.onMasked?.(back.counts, dataClass, { boundary, leg: "response", fellBack });
    assertNoPii(back.value, session.profile, `${boundary} (response)`);

    return new PiiBoundaryResult(
      back.value,
      unmaskValue(back.value, session.map),
      masked.counts,
      back.counts,
      dataClass,
      fellBack,
    );
  };
}

export interface EgressGuardOptions {
  /**
   * The compiled profile the masker used — `maskOutbound(...).profile`, or
   * `compiledProfileFor(policy, trustedClass).profile`.
   *
   * The guard deliberately does not resolve a class itself any more. It used
   * to take `{ policy, dataClass }` and re-resolve, which meant the tripwire
   * trusted the same webhook-supplied label the payload came with: declaring
   * `dataClass: "acik"` was enough to walk a raw TCKN past it (B-6).
   */
  readonly profile: CompiledProfile;
  readonly boundary?: string;
}

/**
 * Runtime half of the fix, for egress points that are not called through
 * `withPiiBoundary` (a storage writer, a notifier). A payload that never went
 * through the boundary — a cast, a spread, a JSON round-trip typed `any` — is
 * rejected before the scan even starts.
 */
export function guardEgress<TIn, TOut>(
  options: EgressGuardOptions,
  send: OutboundCall<TIn, TOut>,
): OutboundCall<TIn, TOut> {
  const boundary = options.boundary ?? "outbound";
  const { profile } = options;
  return async (payload: Masked<TIn>): Promise<TOut> => {
    if (!Masked.is(payload)) throw new PiiLeakError(boundary, [], 0);
    assertNoPii(payload.value, profile, boundary);
    return send(payload);
  };
}

export { Masked } from "./masked.js";
