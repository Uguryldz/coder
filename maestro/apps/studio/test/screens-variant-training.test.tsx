import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { LoadTrainingButton } from "../src/screens/Variants.tsx";
import { renderScreen, stubFetch } from "./harness.tsx";

/**
 * "Varsayılan eğitimi yükle" — the shipped training for the agent's role lands
 * in the persona box; the operator edits from the customer's brief, not from
 * a blank field. Nothing is saved by the button itself.
 */
describe("LoadTrainingButton", () => {
  it("fetches the role's shipped training and hands it to the persona field", async () => {
    const { fetchImpl, calls } = stubFetch([
      { path: "/variants/default-training/planner", body: { role: "planner", persona: "Sen PLANCI AJANSIN. …" } },
    ]);
    const onLoaded = vi.fn();
    renderScreen(<LoadTrainingButton role="planner" onLoaded={onLoaded} />, { fetchImpl });
    await userEvent.click(await screen.findByRole("button", { name: "Varsayılan eğitimi yükle" }));
    await screen.findByText(/plancı rolünün varsayılan eğitimi yüklendi/);
    expect(onLoaded).toHaveBeenCalledWith("Sen PLANCI AJANSIN. …");
    expect(calls.some((call) => call.url.endsWith("/variants/default-training/planner"))).toBe(true);
  });

  it("says so when the role has no shipped training", async () => {
    const { fetchImpl } = stubFetch([{ path: "/variants/default-training/intake", status: 404, body: { error: "no_default_training" } }]);
    const onLoaded = vi.fn();
    renderScreen(<LoadTrainingButton role="intake" onLoaded={onLoaded} />, { fetchImpl });
    await userEvent.click(await screen.findByRole("button", { name: "Varsayılan eğitimi yükle" }));
    await screen.findByText("Bu rol için varsayılan eğitim yok.");
    expect(onLoaded).not.toHaveBeenCalled();
  });
});
