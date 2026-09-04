import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { HealthScreen } from "../src/screens/Health.tsx";
import { ADMIN, DELEGATED_ADMIN, renderScreen, stubFetch, VIEWER } from "./harness.tsx";

const OFF = { level: "off", actor: "kurulum", reason: "ilk kurulum", at: "2026-08-01T00:00:00.000Z" };

/**
 * The kill switch lives on the Sistem sağlığı screen (Health.tsx) and is
 * operated from there only, so these tests render that screen. The other
 * sections it fetches get a quiet, healthy answer: this file is about the
 * switch, not the service table. NOTE: `stubFetch` matches with `endsWith`, so
 * `/studio/config-health` must be listed BEFORE `/studio/health`.
 */
const HEALTH = [
  { path: "/settings", body: { connections: [], notifyDrivers: [] } },
  { path: "/studio/config-health", body: { state: "iyi", findings: [] } },
  { path: "/studio/health", body: { state: "healthy", services: [] } },
] as const;

describe("kill switch", () => {
  it("is a two-step action with a reason, never a bare toggle", async () => {
    const { fetchImpl, calls } = stubFetch([...HEALTH, { path: "/killswitch", body: OFF }]);
    renderScreen(<HealthScreen />, { fetchImpl, session: ADMIN });

    // Pressing the level button must NOT send anything on its own — it only
    // opens the confirmation.
    await userEvent.click(await screen.findByRole("button", { name: "Yeni iş almayı durdur" }));
    const dialog = await screen.findByRole("dialog");
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);

    // And the confirmation refuses to submit without a written reason.
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Yeni iş almayı durdur" }),
    );
    expect(await screen.findByText("Gerekçe zorunlu.")).toBeInTheDocument();
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  it("sends the level and the typed reason once confirmed", async () => {
    const { fetchImpl, calls } = stubFetch([
      ...HEALTH,
      { path: "/killswitch", body: OFF },
      {
        path: "/killswitch",
        method: "POST",
        body: { state: { ...OFF, level: "intake_only" }, stopped: [] },
      },
    ]);
    renderScreen(<HealthScreen />, { fetchImpl, session: ADMIN });

    await userEvent.click(await screen.findByRole("button", { name: "Yeni iş almayı durdur" }));
    await userEvent.type(await screen.findByLabelText("Gerekçe"), "yarın sürüm var");
    // The confirming button inside the dialog, not the row button behind it.
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(
      await within(dialog).findByRole("button", { name: "Yeni iş almayı durdur" }),
    );

    await waitFor(() => {
      const posts = calls.filter((call) => call.method === "POST");
      expect(posts).toHaveLength(1);
      expect(posts[0]?.body).toEqual({ level: "intake_only", reason: "yarın sürüm var" });
    });
  });

  it("hides the controls from a delegated (AI-held) session and says why", async () => {
    const { fetchImpl } = stubFetch([...HEALTH, { path: "/killswitch", body: OFF }]);
    renderScreen(<HealthScreen />, { fetchImpl, session: DELEGATED_ADMIN });

    expect(await screen.findByText(/yalnız insan kanalından/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Her şeyi durdur" })).not.toBeInTheDocument();
  });

  it("hides the controls from a non-admin rather than showing a button that 403s", async () => {
    const { fetchImpl } = stubFetch([...HEALTH, { path: "/killswitch", body: OFF }]);
    renderScreen(<HealthScreen />, { fetchImpl, session: VIEWER });

    expect(await screen.findByText(/yalnızca admin rolüyle/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Yeni iş almayı durdur" })).not.toBeInTheDocument();
  });

  it("warns that stopping everything cannot be undone before it is confirmed", async () => {
    const { fetchImpl } = stubFetch([...HEALTH, { path: "/killswitch", body: OFF }]);
    renderScreen(<HealthScreen />, { fetchImpl, session: ADMIN });

    await userEvent.click(await screen.findByRole("button", { name: "Her şeyi durdur" }));
    expect(await screen.findByText(/geri alınamaz/i)).toBeInTheDocument();
  });

  it("shows the live level from the server, not a local guess", async () => {
    const { fetchImpl } = stubFetch([
      ...HEALTH,
      { path: "/killswitch", body: { ...OFF, level: "all", reason: "olay müdahalesi" } },
    ]);
    renderScreen(<HealthScreen />, { fetchImpl, session: ADMIN });

    expect(await screen.findByText("Tüm işler durduruldu")).toBeInTheDocument();
    // The reason sits on the one-line status beside who set it and when.
    expect(screen.getByText(/olay müdahalesi/)).toBeInTheDocument();
    // Already stopped: offer the way back, not the same action again.
    expect(await screen.findByRole("button", { name: "Normale döndür" })).toBeInTheDocument();
  });
});
