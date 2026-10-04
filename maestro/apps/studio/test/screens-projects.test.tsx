import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ProjectsScreen } from "../src/screens/Projects.tsx";
import { renderScreen, stubFetch } from "./harness.tsx";

/**
 * The projects page is a page of LISTS around a bound project: the bindings
 * (and their approval queue), the listening rules, the registered
 * repositories, and the protected-paths reference. Binding itself happens in
 * the wizard — the numbered "1 · Uygulama ekle → 2 · onay → 3 · kural" strip
 * that re-did the wizard's job with a contradicting form is gone. The tests
 * here cover the page's OWN behaviour — the tab strip, which tab the URL
 * selects, and the empty state — not the screens' internals, which have their
 * own suites.
 *
 * Each tab renders a real screen that fetches, so the stub answers the endpoints
 * those screens hit on mount; the assertions are about the tabs, not the data.
 */

// The endpoints the tabbed screens call on mount, answered emptily.
const STUBS = [
  { path: "/onboarding/options", body: { jiraProjects: [], adoRepos: [], platforms: [] } },
  { path: "/onboarding/scm-connections", body: { connections: [] } },
  { path: "/onboarding/pending", body: { items: [] } },
  { path: "/routing", body: { projects: [], rules: [], policy: { backendByClass: {}, whenOnpremMissing: "block" } } },
  { path: "/studio/apps", body: { items: [], nextCursor: null } },
  { path: "/studio/listening-rules", body: { rules: [] } },
];

const BOUND = STUBS.map((s) =>
  s.path === "/routing"
    ? {
        path: "/routing",
        body: {
          projects: [{ projectKey: "OPS", apps: ["Uguryldz/maestro-pilot"], noteKey: "routing.note.active_by_rule" }],
          rules: [],
          policy: { backendByClass: {}, whenOnpremMissing: "block" },
        },
      }
    : s,
);

describe("projects page (tabbed binding)", () => {
  it("shows the four tabs in the operator's order, with no step numbers", async () => {
    const { fetchImpl } = stubFetch(BOUND);
    renderScreen(<ProjectsScreen />, { fetchImpl, initialEntries: ["/projects"] });

    const tabs = await screen.findAllByRole("tab");
    expect(tabs.map((el) => el.textContent)).toEqual([
      "Bağlı projeler",
      "Dinleme kuralları",
      "Depolar",
      "Korumalı yollar",
    ]);
    // The wizard binds; the page never numbers its tabs as if it did.
    expect(screen.queryByText(/^1 · /)).toBeNull();
    expect(screen.queryByRole("tab", { name: /Uygulama ekle/ })).toBeNull();
  });

  it("opens on the bound-projects list when something is bound", async () => {
    const { fetchImpl } = stubFetch(BOUND);
    renderScreen(<ProjectsScreen />, { fetchImpl, initialEntries: ["/projects"] });

    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Bağlı projeler" })).toHaveAttribute("aria-selected", "true"),
    );
    // Nothing tells a bound install to go to the wizard.
    expect(screen.queryByText("Henüz bağlı proje yok")).toBeNull();
  });

  it("with nothing bound, sends the admin to the wizard instead of a second binding form", async () => {
    const { fetchImpl } = stubFetch(STUBS);
    renderScreen(<ProjectsScreen />, { fetchImpl, initialEntries: ["/projects"] });

    expect(await screen.findByText("Henüz bağlı proje yok")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Kurulum sihirbazını aç" })).toHaveAttribute("href", "/setup");
    // The list tab is the one shown under the prompt — never an add-form.
    expect(screen.getByRole("tab", { name: "Bağlı projeler" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("button", { name: "Admin onayına gönder" })).toBeNull();
  });

  it("selects the tab named in the URL (?tab=)", async () => {
    const { fetchImpl } = stubFetch(STUBS);
    renderScreen(<ProjectsScreen />, { fetchImpl, initialEntries: ["/projects?tab=listening"] });

    expect((await screen.findByRole("tab", { name: "Dinleme kuralları" })).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "Bağlı projeler" })).toHaveAttribute("aria-selected", "false");
    // An explicit tab never shows the wizard prompt: the admin asked for a tab.
    expect(screen.queryByText("Henüz bağlı proje yok")).toBeNull();
  });

  it("still honours old links: ?tab=onboard lands on Depolar", async () => {
    // `/onboard` redirects to `?tab=onboard` and the listening screen's
    // "unbound" note links there; the tab was renamed, the links were not.
    const { fetchImpl } = stubFetch(BOUND);
    renderScreen(<ProjectsScreen />, { fetchImpl, initialEntries: ["/projects?tab=onboard"] });
    expect((await screen.findByRole("tab", { name: "Depolar" })).getAttribute("aria-selected")).toBe("true");
  });

  it("accepts the new id too: ?tab=repos", async () => {
    const { fetchImpl } = stubFetch(BOUND);
    renderScreen(<ProjectsScreen />, { fetchImpl, initialEntries: ["/projects?tab=repos"] });
    expect((await screen.findByRole("tab", { name: "Depolar" })).getAttribute("aria-selected")).toBe("true");
  });

  it("switches the active tab when another is clicked", async () => {
    const { fetchImpl } = stubFetch(BOUND);
    renderScreen(<ProjectsScreen />, { fetchImpl, initialEntries: ["/projects"] });

    await userEvent.click(await screen.findByRole("tab", { name: "Depolar" }));
    expect(screen.getByRole("tab", { name: "Depolar" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText("+ Depo ekle")).toBeInTheDocument();
  });
});
