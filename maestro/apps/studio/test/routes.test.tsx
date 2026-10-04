import { describe, expect, it } from "vitest";
import { SCREEN_COMPONENTS } from "../src/app/screen-components.ts";
import { ALL_SCREEN_IDS, LOGIN_SCREEN, SCREENS, screenById } from "../src/app/screens.ts";

/**
 * The route table is the contract between this skeleton and the screen agents.
 * These tests fail if a screen is dropped, duplicated, or left without a
 * component — which is exactly the breakage a screen agent could cause by
 * editing the table instead of their own file.
 */

/**
 * Every screen the app routes to. Two kinds are deliberately ABSENT:
 *
 *  - the mock-gallery pages (`live`, `jira`, `cache`, `greenfield`) — static
 *    content that was never an operator tool; deleted, their paths redirect;
 *  - the three "yakında" screens (`eval`, `security`, `runners`) — no data
 *    source exists in any deployment, so the page could only ever say "not
 *    yet". Their files stay for the day a store is wired; nothing routes to
 *    them (the operator's rule: either data comes, or there is no page).
 *
 * `projects` gathers the binding steps (onboard / routing / listening / yaml)
 * as tabs; `setup` is the guided wizard over the same configuration.
 */
const EXPECTED_VIEW_IDS = [
  "dash", "detail", "evidence",
  "params", "users", "yaml", "settings", "notify",
  "sandbox", "health", "template", "doctemplate", "knowledge",
  "audit", "pii", "cost", "variant", "variants", "help", "login",
  "projects", "setup",
] as const;
const RETIRED_IDS = [
  "live", "jira", "cache", "greenfield", "eval", "security", "runners",
  // Folded into the run detail's sidebar (P1).
  "clarify", "workmode", "fanout",
  // Folded into Help as reference tabs (P7); their paths redirect there.
  "commands", "mcp",
] as const;

describe("route table", () => {
  it("covers exactly the expected screens", () => {
    expect([...ALL_SCREEN_IDS].sort()).toEqual([...EXPECTED_VIEW_IDS].sort());
    expect(ALL_SCREEN_IDS).toHaveLength(EXPECTED_VIEW_IDS.length);
  });

  it("routes to none of the retired gallery / 'yakında' screens", () => {
    for (const id of RETIRED_IDS) {
      expect(screenById(id), `${id} should have no SCREENS row`).toBeUndefined();
      expect(SCREEN_COMPONENTS[id], `${id} should have no component`).toBeUndefined();
    }
  });

  it("gives every menu entry with a role-checked BFF endpoint a matching roles filter", () => {
    const expectRoles = (id: string, roles: readonly string[]): void => {
      expect([...(screenById(id)?.roles ?? [])].sort(), id).toEqual([...roles].sort());
    };
    expectRoles("users", ["admin"]);
    // The trail's readers mirror BFF `AUDIT_ROLES`: `internal-audit` is a directly granted role, not a group-derived one.
    expectRoles("audit", ["admin", "internal-audit"]);
    for (const id of ["sandbox", "template", "doctemplate", "pii", "cost", "settings", "notify", "params", "health"]) {
      expectRoles(id, ["admin", "tech-lead"]);
    }
    // Everyone's screens carry no filter.
    for (const id of ["dash", "variants", "knowledge", "setup", "projects", "evidence", "help"]) {
      expect(screenById(id)?.roles).toBeUndefined();
    }
  });

  it("has no duplicate id or path", () => {
    expect(new Set(SCREENS.map((s) => s.id)).size).toBe(SCREENS.length);
    expect(new Set(SCREENS.map((s) => s.path)).size).toBe(SCREENS.length);
  });

  it("gives every in-shell screen a component", () => {
    for (const screen of SCREENS) {
      expect(SCREEN_COMPONENTS[screen.id], `missing component for ${screen.id}`).toBeTypeOf(
        "function",
      );
    }
  });

  it("has no orphan component without a table row", () => {
    for (const id of Object.keys(SCREEN_COMPONENTS)) {
      expect(screenById(id), `component ${id} has no SCREENS row`).toBeDefined();
    }
  });

  it("keeps login outside the shell", () => {
    expect(SCREENS.some((s) => s.id === "login")).toBe(false);
    expect(LOGIN_SCREEN.path).toBe("/login");
  });

  it("uses no leading slash on in-shell paths, so they nest under the shell", () => {
    for (const screen of SCREENS) {
      expect(screen.path.startsWith("/")).toBe(false);
    }
  });

  it("only exposes detail through a parameterised path", () => {
    expect(screenById("detail")?.path).toBe("detail/:ticket");
    expect(screenById("detail")?.navKey).toBeUndefined();
  });

  /**
   * The parameters screen is REACHABLE from the menu.
   *
   * It was pulled out with a note saying it would come back "once the engine
   * is connected", and the code that would bring it back was never written.
   * The engine has been connected for a while; the screen stayed hidden, so
   * the twenty-odd operational values an operator is supposed to tune —
   * including the sweep interval — lived on a page only someone typing the URL
   * by hand could reach.
   */
  it("keeps the parameters screen in the menu, not just on a route", () => {
    const params = screenById("params");
    expect(params?.path).toBe("params");
    expect(params?.navKey).toBe("nav.params");
    expect(params?.group).toBe("admin");
  });
});
