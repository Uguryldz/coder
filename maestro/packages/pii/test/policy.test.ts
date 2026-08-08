import { describe, expect, it } from "vitest";
import {
  compileProfile,
  createSession,
  defaultPiiPolicy,
  DETECTOR_TYPES,
  DETECTORS,
  loadPiiPolicy,
  maskText,
  PiiPolicyError,
  resolveProfile,
  STRICTEST_CLASS,
} from "../src/index.js";

const ACCOUNT_PATTERN = { name: "customer-no", pattern: "\\bMST-[0-9]{8}\\b" };

function policyWithAccounts() {
  const base = defaultPiiPolicy();
  return loadPiiPolicy({
    profiles: {
      acik: base.profiles.acik,
      dahili: { ...base.profiles.dahili, accountPatterns: [ACCOUNT_PATTERN] },
      gizli: { ...base.profiles.gizli, accountPatterns: [ACCOUNT_PATTERN] },
    },
  });
}

describe("detector registry", () => {
  it("has exactly one detector per declared type", () => {
    expect(Object.keys(DETECTORS).sort()).toEqual([...DETECTOR_TYPES].sort());
    for (const type of DETECTOR_TYPES) expect(DETECTORS[type].type).toBe(type);
  });
});

describe("policy loading", () => {
  it("accepts the shipped default", () => {
    expect(() => loadPiiPolicy(defaultPiiPolicy())).not.toThrow();
  });

  it("refuses a strictest profile that does not cover every detector", () => {
    const weak = defaultPiiPolicy();
    weak.profiles.gizli.types = ["email"];
    expect(() => loadPiiPolicy(weak)).toThrow(PiiPolicyError);
    expect(() => loadPiiPolicy(weak)).toThrow(/must enable every detector/);
  });

  it("refuses a malformed document instead of masking nothing", () => {
    expect(() => loadPiiPolicy({})).toThrow(PiiPolicyError);
    expect(() => loadPiiPolicy({ profiles: { acik: { types: [] } } })).toThrow(PiiPolicyError);
  });

  it("compiles account patterns eagerly so a broken regex fails at load", () => {
    const broken = defaultPiiPolicy();
    broken.profiles.dahili.accountPatterns = [{ name: "bad", pattern: "MST-([0-9]" }];
    expect(() => loadPiiPolicy(broken)).toThrow(PiiPolicyError);
  });
});

describe("profile resolution is fail-closed (M18/M63)", () => {
  const policy = policyWithAccounts();

  it("uses the declared class when it is one we know", () => {
    expect(resolveProfile(policy, "acik")).toMatchObject({ dataClass: "acik", fellBack: false });
    expect(resolveProfile(policy, "dahili")).toMatchObject({ dataClass: "dahili", fellBack: false });
  });

  it.each([undefined, null, "", "top-secret", 7, {}])(
    "falls back to the strictest profile for %o",
    (input) => {
      const resolved = resolveProfile(policy, input);
      expect(resolved.dataClass).toBe(STRICTEST_CLASS);
      expect(resolved.fellBack).toBe(true);
    },
  );

  it("makes the fallback actually mask more than the public profile", () => {
    const text = "Musteri MST-12345678 kaydi";
    const acik = maskText(text, createSession(resolveProfile(policy, "acik").profile));
    const unknown = maskText(text, createSession(resolveProfile(policy, "bilinmiyor").profile));
    expect(acik.text).toBe(text);
    expect(unknown.text).toBe("Musteri [ACCT_1] kaydi");
  });
});

describe("profile compilation", () => {
  it("selects only the enabled detectors, in priority order", () => {
    const compiled = compileProfile({ types: ["email", "iban"], accountPatterns: [], fieldRules: [] });
    expect(compiled.detectors.map((d) => d.type)).toEqual(["iban", "email"]);
  });

  it("lower-cases field rules so field matching is case-insensitive", () => {
    const compiled = compileProfile({ types: ["email"], accountPatterns: [], fieldRules: ["Customer_Name"] });
    expect(compiled.fieldRules.has("customer_name")).toBe(true);
  });
});
