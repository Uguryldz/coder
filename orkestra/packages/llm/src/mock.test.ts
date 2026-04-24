import {
  AnalystOutput,
  DeveloperOutput,
  DevReviewerOutput,
  IntakeOutput,
  TestDesignerOutput,
  TestReviewerOutput,
  TestRunnerOutput,
} from "@orkestra/contracts";
import { describe, expect, it } from "vitest";
import { MockLLM } from "./mock.js";

describe("MockLLM produces schema-valid output for every role", () => {
  it("intake", () => {
    const out = MockLLM.output("intake", "example ticket with some description content");
    expect(() => IntakeOutput.parse(JSON.parse(out))).not.toThrow();
  });
  it("analyst", () => {
    const out = MockLLM.output("analyst", "ticket desc");
    expect(() => AnalystOutput.parse(JSON.parse(out))).not.toThrow();
  });
  it("developer", () => {
    const out = MockLLM.output("developer", "analysis");
    expect(() => DeveloperOutput.parse(JSON.parse(out))).not.toThrow();
  });
  it("dev_reviewer", () => {
    const out = MockLLM.output("dev_reviewer", "patch");
    expect(() => DevReviewerOutput.parse(JSON.parse(out))).not.toThrow();
  });
  it("test_designer", () => {
    const out = MockLLM.output("test_designer", "analysis");
    const parsed = TestDesignerOutput.parse(JSON.parse(out));
    // pyramid check
    const types = new Set(parsed.scenarios.map((s) => s.type));
    expect(types.has("unit")).toBe(true);
    expect(types.has("integration")).toBe(true);
    expect(types.has("e2e")).toBe(true);
    expect(parsed.scenarios.some((s) => s.negative)).toBe(true);
  });
  it("test_reviewer", () => {
    const out = MockLLM.output("test_reviewer", "scenarios");
    expect(() => TestReviewerOutput.parse(JSON.parse(out))).not.toThrow();
  });
  it("test_runner", () => {
    const out = MockLLM.output("test_runner", "scenarios");
    const parsed = TestRunnerOutput.parse(JSON.parse(out));
    expect(parsed.overallPassed).toBe(true);
    expect(parsed.coveragePct).toBeGreaterThanOrEqual(70);
  });
});
