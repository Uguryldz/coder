import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { PilotSettingsPanel } from "../src/screens/settings/PilotSettingsPanel.tsx";
import { ADMIN, VIEWER, renderScreen, stubFetch } from "./harness.tsx";

/**
 * The engine-settings panel. Its load-bearing property is being SCHEMA-AGNOSTIC:
 * the pilot owns the settings vocabulary, so a field this build has never heard
 * of (here `autoStart`) must render by type, stay editable, and above all
 * survive the round-trip — the POST carries the WHOLE object, not a whitelist.
 */

const SETTINGS = {
  approverGroup: "leads",
  model: "claude-opus-5",
  commandPollMs: 5000,
  discoveryPollMs: 15000,
  dataClass: "gizli",
  operatorAccount: "ugur@corp",
  sandboxRoot: "/srv/sandbox",
  reviewStatusName: "İNCELEMEDE",
  autoMerge: false,
  // A field the ENGINE added after this build shipped:
  autoStart: true,
};

const GET_ROUTE = { path: "/studio/pilot/settings", body: SETTINGS };

describe("PilotSettingsPanel", () => {
  it("renders known fields with labels and unknown fields by type", async () => {
    const { fetchImpl } = stubFetch([GET_ROUTE]);
    renderScreen(<PilotSettingsPanel />, { fetchImpl, session: ADMIN });

    expect(await screen.findByLabelText("Onaylayan grup")).toHaveValue("leads");
    expect(screen.getByLabelText("Model")).toHaveValue("claude-opus-5");
    expect(screen.getByLabelText("Komut yoklama aralığı (ms)")).toHaveValue(5000);
    expect(screen.getByLabelText("Veri sınıfı")).toHaveValue("gizli");
    expect(screen.getByRole("checkbox", { name: /auto-merge/ })).not.toBeChecked();
    // The unknown boolean renders as a checkbox under its machine name.
    expect(screen.getByRole("checkbox", { name: "autoStart" })).toBeChecked();
  });

  it("POSTs the WHOLE object — edited fields overwritten, unknown fields preserved", async () => {
    const { fetchImpl, calls } = stubFetch([
      GET_ROUTE,
      { path: "/studio/pilot/settings", method: "POST", body: SETTINGS },
    ]);
    renderScreen(<PilotSettingsPanel />, { fetchImpl, session: ADMIN });

    const model = await screen.findByLabelText("Model");
    await userEvent.clear(model);
    await userEvent.type(model, "claude-sonnet-5");
    await userEvent.click(screen.getByRole("button", { name: "Kaydet" }));

    await waitFor(() => {
      const post = calls.find(
        (call) => call.url.endsWith("/studio/pilot/settings") && call.method === "POST",
      );
      expect(post).toBeDefined();
      expect(post?.body).toMatchObject({
        model: "claude-sonnet-5",
        // Untouched knowns arrive exactly as fetched…
        approverGroup: "leads",
        commandPollMs: 5000,
        autoMerge: false,
        // …and the field this build does not know is NOT dropped.
        autoStart: true,
      });
    });
  });

  it("shows the engine's mid-run refusal (409) as its own Turkish sentence", async () => {
    const { fetchImpl } = stubFetch([
      GET_ROUTE,
      {
        path: "/studio/pilot/settings",
        method: "POST",
        status: 409,
        body: { error: "akış sürerken değiştirilemez" },
      },
    ]);
    renderScreen(<PilotSettingsPanel />, { fetchImpl, session: ADMIN });

    await screen.findByLabelText("Model");
    await userEvent.click(screen.getByRole("button", { name: "Kaydet" }));

    expect(await screen.findByText(/ayarlar akış sürerken değiştirilemez/)).toBeInTheDocument();
  });

  it("is read-only for a viewer: fields visible, no save button", async () => {
    const { fetchImpl } = stubFetch([GET_ROUTE]);
    renderScreen(<PilotSettingsPanel />, { fetchImpl, session: VIEWER });

    expect(await screen.findByLabelText("Onaylayan grup")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Kaydet" })).not.toBeInTheDocument();
    expect(screen.getByText("Ayarları yalnızca admin veya tech-lead değiştirebilir.")).toBeInTheDocument();
  });
});
