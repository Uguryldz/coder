import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StartGuide } from "../src/screens/dash/StartGuide.tsx";
import { renderScreen, stubFetch } from "./harness.tsx";

/**
 * The first-run start guide on the Panel.
 *
 * It answers "what do I do first" for a manager who just logged in: a numbered
 * checklist whose steps report their real state, with the first unfinished step
 * highlighted. These tests cover that logic — a done step is checked, and the
 * "do this next" nudge lands on the earliest unfinished step.
 */

// Nothing set up yet: no connections, no binding, no rule.
const EMPTY = [
  { path: "/onboarding/jira-connections", body: { connections: [] } },
  { path: "/onboarding/scm-connections", body: { connections: [] } },
  { path: "/routing", body: { projects: [], rules: [], policy: null } },
  { path: "/studio/listening-rules", body: { rules: [] } },
];

describe("start guide", () => {
  it("shows the four steps and nudges the first one when nothing is set up", async () => {
    const { fetchImpl } = stubFetch(EMPTY);
    renderScreen(<StartGuide />, { fetchImpl });

    expect(await screen.findByText("Bağlantıları kur")).toBeInTheDocument();
    expect(screen.getByText("İlk uygulamanı bağla")).toBeInTheDocument();
    expect(screen.getByText("Dinleme kuralı ekle")).toBeInTheDocument();
    expect(screen.getByText("İlk işini izle")).toBeInTheDocument();

    // The nudge is on step 1 (connections) — the first unfinished step.
    const nudges = screen.getAllByText("Şimdi bunu yap →");
    expect(nudges).toHaveLength(1);
    const step1 = screen.getByText("Bağlantıları kur").closest("button");
    expect(step1).toContainElement(nudges[0]!);
  });

  it("checks completed steps and moves the nudge to the first unfinished one", async () => {
    // Connection + binding done, but no listening rule yet.
    const { fetchImpl } = stubFetch([
      { path: "/onboarding/jira-connections", body: { connections: [{ id: "jira" }] } },
      { path: "/onboarding/scm-connections", body: { connections: [{ id: "gh" }] } },
      { path: "/routing", body: { projects: [{ projectKey: "OPS" }], rules: [], policy: null } },
      { path: "/studio/listening-rules", body: { rules: [] } },
    ]);
    renderScreen(<StartGuide />, { fetchImpl });

    // Once all four reads resolve, step 3 (listening rule) is the first
    // unfinished one → it gets the nudge, and steps 1 & 2 are marked done.
    await waitFor(() => {
      const step3 = screen.getByText("Dinleme kuralı ekle").closest("button")!;
      expect(step3.className).toContain("dash-start__step--next");
    });
    const step1 = screen.getByText("Bağlantıları kur").closest("button")!;
    expect(step1.className).toContain("dash-start__step--done");
    const step2 = screen.getByText("İlk uygulamanı bağla").closest("button")!;
    expect(step2.className).toContain("dash-start__step--done");
  });
});
