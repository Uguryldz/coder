import type { JiraTicket } from "@orkestra/contracts";
import { describe, expect, it } from "vitest";
import { detectWorkMode } from "./routing.js";

function ticket(partial: Partial<JiraTicket>): JiraTicket {
  return {
    id: "x",
    key: "X-1",
    projectKey: "X",
    summary: "s",
    description: "",
    issueType: "Task",
    status: "Open",
    labels: [],
    components: [],
    customFields: {},
    ...partial,
  };
}

describe("work mode detection", () => {
  it("full_auto by default", () => {
    expect(detectWorkMode(ticket({}))).toBe("full_auto");
  });
  it("detects ai_assist from label", () => {
    expect(detectWorkMode(ticket({ labels: ["mode:ai-assist"] }))).toBe("ai_assist");
  });
  it("detects human_lead from label alias", () => {
    expect(detectWorkMode(ticket({ labels: ["ai:review-only"] }))).toBe("human_lead");
  });
  it("detects human_only from label", () => {
    expect(detectWorkMode(ticket({ labels: ["mode:human-only"] }))).toBe("human_only");
  });
  it("falls back to explicit default when no label matches", () => {
    expect(detectWorkMode(ticket({ labels: ["feature", "priority:p1"] }), "human_lead")).toBe(
      "human_lead",
    );
  });
});
