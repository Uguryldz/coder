import { describe, expect, it } from "vitest";
import {
  selectDoneTransition,
  selectReturnTransition,
  type AvailableTransition,
} from "../../src/cloud/return-flow.js";

/**
 * Transition selection is by status CATEGORY, never by a hard-coded name — a
 * Jira site renames "Done"/"To Do" freely, but the category key is stable. These
 * tests pin that: the Done selector finds the merged-ticket close transition, and
 * a workflow with no Done edge yields null (not an error).
 */

function tr(over: Partial<AvailableTransition>): AvailableTransition {
  return {
    id: "1",
    name: "Move",
    toStatusId: "s1",
    toStatusName: "Status",
    toCategoryKey: "indeterminate",
    toCategoryName: "In Progress",
    ...over,
  };
}

describe("selectDoneTransition", () => {
  it("picks the transition whose destination is in the Done category (by key)", () => {
    const transitions = [
      tr({ id: "10", toStatusName: "Devam Ediyor", toCategoryKey: "indeterminate" }),
      tr({ id: "20", toStatusName: "Tamam", toCategoryKey: "done", toCategoryName: "Done" }),
    ];
    expect(selectDoneTransition(transitions)?.id).toBe("20");
  });

  it("matches a renamed Done column by category name when the key is absent", () => {
    const transitions = [tr({ id: "30", toStatusName: "Kapandı", toCategoryKey: "", toCategoryName: "Done" })];
    expect(selectDoneTransition(transitions)?.id).toBe("30");
  });

  it("returns null when no transition leads to a Done status", () => {
    const transitions = [
      tr({ toCategoryKey: "new", toCategoryName: "To Do" }),
      tr({ toCategoryKey: "indeterminate", toCategoryName: "In Progress" }),
    ];
    expect(selectDoneTransition(transitions)).toBeNull();
  });

  it("does not confuse Done with To Do", () => {
    const transitions = [tr({ toCategoryKey: "new", toCategoryName: "To Do" })];
    expect(selectDoneTransition(transitions)).toBeNull();
    expect(selectReturnTransition(transitions)).not.toBeNull();
  });
});
