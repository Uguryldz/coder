import { describe, expect, it } from "vitest";
import { parseJiraCommand } from "./commands.js";

describe("parseJiraCommand", () => {
  it("parses /approve", () => {
    const r = parseJiraCommand("/approve");
    expect(r?.command).toBe("approve");
  });
  it("parses /reject with reason", () => {
    const r = parseJiraCommand("/reject missing acceptance criteria");
    expect(r?.command).toBe("reject");
    expect(r?.args).toContain("missing acceptance criteria");
  });
  it("tolerates whitespace", () => {
    const r = parseJiraCommand("   /cancel  too broad   ");
    expect(r?.command).toBe("cancel");
  });
  it("rejects non-commands", () => {
    expect(parseJiraCommand("just a regular comment")).toBeNull();
  });
  it("rejects unknown commands", () => {
    expect(parseJiraCommand("/frobnicate")).toBeNull();
  });
  it("parses /ai-takeover", () => {
    const r = parseJiraCommand("/ai-takeover");
    expect(r?.command).toBe("ai-takeover");
  });
});
