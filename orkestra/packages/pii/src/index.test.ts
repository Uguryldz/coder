import { describe, expect, it } from "vitest";
import { maskObject, maskText, ReverseMap, type PIIConfig } from "./index.js";

const config: PIIConfig = {
  enabled: true,
  fieldRules: [
    { field: "customer_email", strategy: "hash" },
    { field: "customer_name", strategy: "redact" },
    { field: "phone", strategy: "partial" },
  ],
  patternRules: [
    { name: "tc_kimlik", regex: "\\b[1-9][0-9]{10}\\b", replacement: "[TC]" },
    { name: "email", regex: "[\\w.+-]+@[\\w-]+\\.[\\w.-]+", replacement: "[EMAIL]" },
  ],
};

describe("pii masking", () => {
  it("masks pattern rules in text", () => {
    const out = maskText("bana user@example.com gönderdi, TC 12345678901", config);
    expect(out).not.toContain("user@example.com");
    expect(out).not.toContain("12345678901");
  });

  it("masks field rules in object", () => {
    const obj = {
      customer_email: "ayse@example.com",
      customer_name: "Ayşe Yılmaz",
      phone: "+905551234567",
      note: "reach me at ayse@example.com please",
    };
    const out = maskObject(obj, config);
    expect(out.customer_email).not.toEqual("ayse@example.com");
    expect(out.customer_email).toContain("@example.com");
    expect(out.customer_name).toBe("[REDACTED]");
    expect(out.phone).toContain("***");
    expect(out.note).not.toContain("ayse@example.com");
  });

  it("reverse map allows restoration", () => {
    const rm = new ReverseMap();
    const masked = maskText("call ayse@example.com", config, rm);
    const restored = rm.applyReverse(masked);
    expect(restored).toContain("ayse@example.com");
  });

  it("disabled config passes through", () => {
    const out = maskText("ayse@example.com", { ...config, enabled: false });
    expect(out).toBe("ayse@example.com");
  });
});
