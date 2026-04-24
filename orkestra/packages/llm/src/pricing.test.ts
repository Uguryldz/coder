import { describe, expect, it } from "vitest";
import { estimateCostUsd, PRICING } from "./pricing.js";

describe("pricing", () => {
  it("has the 3 canonical models", () => {
    expect(PRICING["claude-opus-4-7"]).toBeTruthy();
    expect(PRICING["claude-sonnet-4-6"]).toBeTruthy();
    expect(PRICING["claude-haiku-4-5-20251001"]).toBeTruthy();
  });

  it("discounts cache hits", () => {
    const full = estimateCostUsd("claude-opus-4-7", 1_000_000, 0, 0);
    const cached = estimateCostUsd("claude-opus-4-7", 1_000_000, 0, 900_000);
    expect(cached).toBeLessThan(full);
    expect(cached / full).toBeLessThan(0.2); // order of magnitude cheaper
  });

  it("falls back to sonnet pricing on unknown model", () => {
    const expected = estimateCostUsd("claude-sonnet-4-6", 1000, 1000);
    const actual = estimateCostUsd("unknown-model", 1000, 1000);
    expect(actual).toBe(expected);
  });
});
