import { DataClass } from "@maestro/contracts";
import { compileAccountPatterns, DETECTORS } from "./detectors/index.js";
import { PiiPolicyError } from "./errors.js";
import {
  DETECTOR_TYPES,
  MaskProfile,
  PiiPolicy,
  type DataClassName,
  type Detector,
  type DetectorContext,
} from "./types.js";

/** The class a payload falls back to when its declared class is unusable. */
export const STRICTEST_CLASS: DataClassName = "gizli";

/**
 * Install-time default (M18/M63 leave the real values to the compliance
 * team). Every class masks every checksum-verifiable identifier; the only
 * axis that moves is the institution's own account patterns, which are an
 * internal concept and are not applied to public-class material.
 */
export function defaultPiiPolicy(): PiiPolicy {
  const identifiers = ["iban", "card", "tckn", "phone", "email"] as const;
  return {
    profiles: {
      acik: { types: [...identifiers], accountPatterns: [], fieldRules: [] },
      dahili: { types: [...DETECTOR_TYPES], accountPatterns: [], fieldRules: [] },
      gizli: { types: [...DETECTOR_TYPES], accountPatterns: [], fieldRules: [] },
    },
  };
}

/**
 * Parse and validate a policy document. The `gizli` profile is forced to
 * cover every detector type, because it is also the fallback for an unknown
 * class: weakening it would turn "we do not know what this is" into "mask
 * less", which is exactly backwards.
 */
export function loadPiiPolicy(input: unknown): PiiPolicy {
  const parsed = PiiPolicy.safeParse(input);
  if (!parsed.success) {
    throw new PiiPolicyError(
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
  }
  const policy = parsed.data;
  const strict = policy.profiles[STRICTEST_CLASS];
  const missing = DETECTOR_TYPES.filter((t) => !strict.types.includes(t));
  if (missing.length > 0) {
    throw new PiiPolicyError(
      `the "${STRICTEST_CLASS}" profile is the fallback for unknown data classes ` +
        `and must enable every detector; missing: ${missing.join(", ")}`,
    );
  }
  // Compile every profile's patterns now so a broken regex fails at load.
  for (const profile of Object.values(policy.profiles)) {
    compileAccountPatterns(profile.accountPatterns);
  }
  return policy;
}

export interface ResolvedProfile {
  readonly dataClass: DataClassName;
  readonly profile: MaskProfile;
  /** True when the declared class was missing or unrecognised (fail-closed). */
  readonly fellBack: boolean;
}

/**
 * Pick the profile for a payload. The argument is `unknown` on purpose: the
 * caller often gets the class from a webhook or a Jira field, and an absent
 * or unrecognised value must land on the strictest profile rather than throw
 * and tempt someone into a try/catch that skips masking.
 */
export function resolveProfile(policy: PiiPolicy, dataClass: unknown): ResolvedProfile {
  const parsed = DataClass.safeParse(dataClass);
  const name: DataClassName = parsed.success ? parsed.data : STRICTEST_CLASS;
  return { dataClass: name, profile: policy.profiles[name], fellBack: !parsed.success };
}

/** A profile with its regexes compiled and its detectors selected. */
export interface CompiledProfile {
  readonly detectors: readonly Detector[];
  readonly detectorContext: DetectorContext;
  /** Lower-cased field names whose whole value is replaced. */
  readonly fieldRules: ReadonlySet<string>;
}

export function compileProfile(profile: MaskProfile): CompiledProfile {
  const parsed = MaskProfile.parse(profile);
  const accountPatterns = compileAccountPatterns(parsed.accountPatterns);
  const detectors = DETECTOR_TYPES.filter((t) => parsed.types.includes(t)).map((t) => DETECTORS[t]);
  return {
    detectors,
    detectorContext: { accountPatterns },
    fieldRules: new Set(parsed.fieldRules.map((f) => f.toLowerCase())),
  };
}
