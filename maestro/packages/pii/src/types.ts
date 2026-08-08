import { DataClass, NonEmpty } from "@maestro/contracts";
import { z } from "zod";

/**
 * Detector types, in overlap-resolution priority order: when two detectors
 * claim the same span with the same length, the earlier one wins. IBAN and
 * card come first because they are the longest and the most checksum-bound.
 */
export const DETECTOR_TYPES = ["iban", "card", "tckn", "phone", "email", "account"] as const;
export const DetectorType = z.enum(DETECTOR_TYPES);
export type DetectorType = z.infer<typeof DetectorType>;

/**
 * Everything a token can stand for. `field` is not a detector: it is the
 * field-rule half of M20 ("field + regex") — a named field whose whole value
 * is replaced regardless of what the detectors think of it.
 */
export const PII_TYPES = [...DETECTOR_TYPES, "field"] as const;
export const PiiType = z.enum(PII_TYPES);
export type PiiType = z.infer<typeof PiiType>;

/**
 * Token prefixes. Tokens stay human-readable (`[TCKN_1]`) on purpose: the
 * model has to be able to reason about "the customer's TCKN" without ever
 * seeing it, and a reviewer has to be able to read the masked prompt.
 */
export const TOKEN_PREFIX: Readonly<Record<PiiType, string>> = {
  iban: "IBAN",
  card: "CARD",
  tckn: "TCKN",
  phone: "PHONE",
  email: "EMAIL",
  account: "ACCT",
  field: "FIELD",
};

/**
 * Both token regexes are derived from TOKEN_PREFIX rather than spelled out:
 * the minter and the reader of a token must never be able to drift apart.
 */
export const TOKEN_PATTERN_SOURCE = `\\[(${Object.values(TOKEN_PREFIX).join("|")})_(\\d+)\\]`;

/** A string that is nothing but a token — already masked, leave it alone. */
export const WHOLE_TOKEN_PATTERN = new RegExp(`^${TOKEN_PATTERN_SOURCE}$`);

/**
 * Operator-defined identifier shape (customer no, account no, contract no).
 * These have no checksum, so they are opt-in per profile and never active by
 * default in the `acik` profile.
 */
export const AccountPattern = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  /** JS regular expression source. The `g` flag is added by this package. */
  pattern: NonEmpty,
});
export type AccountPattern = z.infer<typeof AccountPattern>;

/** What gets masked for one data class. */
export const MaskProfile = z.object({
  types: z.array(DetectorType).min(1),
  accountPatterns: z.array(AccountPattern).default([]),
  /** Field names (case-insensitive) whose string value is always replaced. */
  fieldRules: z.array(NonEmpty).default([]),
});
export type MaskProfile = z.infer<typeof MaskProfile>;

/**
 * Masking policy (M18/M63: filled in with the compliance team at install
 * time). One profile per data class; an unknown class falls back to `gizli`,
 * which `loadPiiPolicy` forces to cover every detector type.
 */
export const PiiPolicy = z.object({
  profiles: z.object({
    acik: MaskProfile,
    dahili: MaskProfile,
    gizli: MaskProfile,
  }),
});
export type PiiPolicy = z.infer<typeof PiiPolicy>;

export type DataClassName = z.infer<typeof DataClass>;

/** One detected occurrence inside a single string. */
export interface PiiMatch {
  readonly type: DetectorType;
  readonly start: number;
  readonly end: number;
  /** The literal text as it appeared — what `unmask` restores. */
  readonly text: string;
  /** Normalised identity: two spellings of one value share a token. */
  readonly canonical: string;
}

export interface DetectorContext {
  readonly accountPatterns: readonly RegExp[];
}

export interface Detector {
  readonly type: DetectorType;
  scan(text: string, ctx: DetectorContext): PiiMatch[];
}

/**
 * Audit payload (M33 `PII_MASKED`). Counts only — a real value must never be
 * reachable from anything an auditor, a log line or a notification can read.
 */
export interface MaskCounts {
  /** Total replaced occurrences. */
  readonly occurrences: number;
  /** Distinct leaves (JSON fields / whole strings) that changed. */
  readonly fields: number;
  readonly byType: Readonly<Partial<Record<PiiType, number>>>;
}
