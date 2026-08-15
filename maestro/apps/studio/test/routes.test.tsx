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
 * Every view id in mock/index.html that is still its own screen. `onboard` and
 * `routing` were in the mock but merged into the `projects` page (three tabs),
 * so they are no longer standalone screen ids — see POST_MOCK_VIEW_IDS.
 */
const MOCK_VIEW_IDS = [
  "dash", "detail", "live", "clarify", "workmode", "fanout", "evidence",
  "jira", "params", "users", "yaml", "settings", "notify", "commands",
  "mcp", "runners", "sandbox", "health", "template", "doctemplate", "knowledge",
  "audit", "pii", "security", "issues", "cost", "variant",
  "variants", "eval", "cache", "greenfield", "help", "login",
] as const;

/**
 * Screens added AFTER the mock froze, or reshaped after it. `pilot` (Dalga D) is
 * Studio's face for the pilot's real-Jira flow, `flow` draws that project's live
 * Jira workflow as SVG. `projects` is the ONE page that gathers the three
 * project-binding steps — add application, Jira mapping & approval, listening
 * rules — which used to be the separate `onboard`, `routing` and `listening`
 * screens (now its tabs; their old paths redirect into it). Listed explicitly so
 * the coverage check stays honest: a dropped or accidental screen still fails.
 */
const POST_MOCK_VIEW_IDS = ["pilot", "projects"] as const;
const EXPECTED_VIEW_IDS = [...MOCK_VIEW_IDS, ...POST_MOCK_VIEW_IDS];

describe("route table", () => {
  it("covers every screen in the mock, plus the intentional post-mock additions", () => {
    expect([...ALL_SCREEN_IDS].sort()).toEqual([...EXPECTED_VIEW_IDS].sort());
  });

  it("declares exactly the mock screens plus the post-mock additions", () => {
    expect(ALL_SCREEN_IDS).toHaveLength(EXPECTED_VIEW_IDS.length);
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
});
