import { PiiReverseMapLeakError } from "./errors.js";
import { TOKEN_PATTERN_SOURCE, TOKEN_PREFIX, type PiiType } from "./types.js";

const INSPECT = Symbol.for("nodejs.util.inspect.custom");
const TOKEN_LOOKUP = new RegExp(TOKEN_PATTERN_SOURCE, "g");

/**
 * Token -> real value, scoped to one masking session (M20).
 *
 * Two rules this class enforces structurally rather than by convention:
 *
 * 1. The same value gets the same token for the whole session, so the model
 *    can reason ("[TCKN_1] appears in both the ticket and the log") without
 *    ever seeing the value.
 * 2. The map is not serialisable. Every path that would put it into a log
 *    line, a JSON body or a structured clone yields either an exception or a
 *    size-only summary. This is the structure that must never leave process
 *    memory, so `toJSON` throws instead of quietly emitting the values.
 */
export class ReverseMap {
  readonly #byToken = new Map<string, string>();
  readonly #byCanonical = new Map<string, string>();
  readonly #counters = new Map<PiiType, number>();

  /** Number of distinct values held. Safe to log. */
  get size(): number {
    return this.#byToken.size;
  }

  /**
   * Token for one occurrence. `canonical` decides identity, `original` is what
   * `unmask` restores; the first spelling seen wins, later spellings of the
   * same value reuse the token.
   */
  tokenFor(type: PiiType, canonical: string, original: string): string {
    const key = `${type}:${canonical}`;
    const existing = this.#byCanonical.get(key);
    if (existing !== undefined) return existing;
    const next = (this.#counters.get(type) ?? 0) + 1;
    this.#counters.set(type, next);
    const token = `[${TOKEN_PREFIX[type]}_${next}]`;
    this.#byCanonical.set(key, token);
    this.#byToken.set(token, original);
    return token;
  }

  /** True when the token was minted by this session. */
  has(token: string): boolean {
    return this.#byToken.has(token);
  }

  /**
   * Put the real values back into model output (M20: only on the way to a
   * human). Tokens this session never minted are left untouched — a model
   * that invents `[TCKN_9]` gets no answer rather than someone else's value.
   */
  unmask(text: string): string {
    if (this.#byToken.size === 0) return text;
    return text.replace(TOKEN_LOOKUP, (token) => this.#byToken.get(token) ?? token);
  }

  toJSON(): never {
    throw new PiiReverseMapLeakError("toJSON");
  }

  toString(): string {
    return `ReverseMap(size=${this.size})`;
  }

  [INSPECT](): string {
    return `ReverseMap { size: ${this.size} }`;
  }
}
