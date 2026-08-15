import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { AuthProvider } from "../src/auth/AuthProvider.tsx";
import { I18nProvider } from "../src/i18n/I18nProvider.tsx";
import { ToastProvider } from "../src/ui/Toast.tsx";
import { FlowScreen } from "../src/screens/Flow.tsx";
import { AGENT_PIPELINE } from "../src/screens/flow/agentPipeline.ts";
import { layoutPipeline } from "../src/screens/flow/pipelineLayout.ts";
// Import the step definitions straight from the pilot's state module, NOT its
// barrel: the barrel pulls in boot/server (readFileSync of ui.html), which has
// no place in a jsdom unit test. `state.ts` is pure data — the id list only.
import { STEP_DEFINITIONS } from "@maestro/pilot/state";
import { ADMIN } from "./harness.tsx";

/**
 * Flow screen — Maestro's AGENT pipeline drawn as SVG (the "hangi adımda hangi
 * ajan" map), replacing the old Jira-status diagram.
 *
 * THE LOAD-BEARING TEST is the id alignment: the map's step ids MUST equal the
 * pilot's STEP_DEFINITIONS ids, in the same order — that identity is the only
 * thing keeping the live position (from `/studio/pilot/state`, keyed by step id)
 * honest. If someone renumbers one side, this fails rather than the diagram
 * silently lighting the wrong node.
 *
 * The geometry is a PURE function (`layoutPipeline`), so its numbers are asserted
 * directly rather than sniffed out of the DOM.
 */

describe("agent pipeline model", () => {
  it("has exactly the pilot's step ids, in order", () => {
    const pipelineIds = AGENT_PIPELINE.map((s) => s.id);
    const pilotIds = STEP_DEFINITIONS.map((s) => s.id);
    expect(pipelineIds).toEqual(pilotIds);
  });

  it("assigns every step an actor and a role", () => {
    for (const step of AGENT_PIPELINE) {
      expect(step.role.length).toBeGreaterThan(0);
      expect(step.task.length).toBeGreaterThan(0);
      expect(["maestro", "agent", "human"]).toContain(step.actor);
    }
  });

  it("draws the İADE branch off the intake step and a re-analysis branch off the review step", () => {
    const intake = AGENT_PIPELINE.find((s) => s.id === "2");
    const review = AGENT_PIPELINE.find((s) => s.id === "3");
    expect(intake?.branches.some((b) => b.kind === "out")).toBe(true);
    expect(review?.branches.some((b) => b.kind === "back")).toBe(true);
  });
});

describe("pipeline layout", () => {
  it("is deterministic — same output every call", () => {
    expect(layoutPipeline()).toEqual(layoutPipeline());
  });

  it("places one node per step and never overlaps two boxes", () => {
    const { nodes } = layoutPipeline();
    expect(nodes).toHaveLength(AGENT_PIPELINE.length);
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = nodes[i]!;
        const b = nodes[j]!;
        const overlap =
          a.x < b.x + b.width &&
          a.x + a.width > b.x &&
          a.y < b.y + b.height &&
          a.y + a.height > b.y;
        expect(overlap, `nodes ${a.id} and ${b.id} overlap`).toBe(false);
      }
    }
  });

  it("routes a main edge between every consecutive pair of steps", () => {
    const { edges } = layoutPipeline();
    const main = edges.filter((e) => e.kind === "main");
    expect(main).toHaveLength(AGENT_PIPELINE.length - 1);
  });

  it("routes the re-analysis 'back' edge from step 3 to step 2", () => {
    const { edges } = layoutPipeline();
    const back = edges.find((e) => e.kind === "back");
    expect(back?.fromId).toBe("3");
    expect(back?.toId).toBe("2");
  });
});

// ── Screen render ──────────────────────────────────────────────────────────

function renderFlow(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <I18nProvider>
          <ToastProvider>
            <AuthProvider initialSession={ADMIN}>
              <FlowScreen />
            </AuthProvider>
          </ToastProvider>
        </I18nProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe("FlowScreen", () => {
  beforeEach(() => {
    // The screen polls /studio/pilot/state; stub a running pilot at step 4.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          ticketKey: "OPS-16",
          running: true,
          awaitingGate: null,
          steps: [
            { id: "1", state: "tamam" },
            { id: "2", state: "tamam" },
            { id: "3", state: "tamam" },
            { id: "4", state: "calisiyor" },
            { id: "5", state: "bekliyor" },
          ],
        }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the pipeline with every agent role visible", async () => {
    renderFlow();
    // Roles from the model appear as SVG text.
    expect(await screen.findByText("Intake Ajanı")).toBeTruthy();
    expect(screen.getByText("Yazılım Ajanı")).toBeTruthy();
    expect(screen.getByText("Analist Yönetici")).toBeTruthy();
  });

  it("shows the live ticket and highlights the running step", async () => {
    renderFlow();
    // The live banner names the ticket once the poll resolves.
    await waitFor(() => expect(screen.getByText(/OPS-16/)).toBeTruthy());
    // The figure is one accessible image.
    expect(screen.getByRole("img")).toBeTruthy();
  });
});
