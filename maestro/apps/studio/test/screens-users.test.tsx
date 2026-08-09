import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { UsersScreen } from "../src/screens/Users.tsx";
import { ADMIN, DELEGATED_ADMIN, renderScreen, stubFetch, VIEWER } from "./harness.tsx";

const ACTIVE_USER = {
  userId: "deniz.yalcin@ugurbank.local",
  username: "deniz.yalcin",
  displayName: "Deniz Yalçın",
  groups: ["qa"],
  roles: ["qa"],
  active: true,
  activeSessions: 1,
  lastLoginAt: "2026-08-08T09:00:00.000Z",
};

/** A revoked account whose bearer tokens outlived the revocation. */
const REVOKED_BUT_LIVE = {
  ...ACTIVE_USER,
  userId: "baran.tunc@ugurbank.local",
  username: "baran.tunc",
  displayName: "Baran Tunç",
  roles: ["developer"],
  active: false,
  activeSessions: 2,
};

function usersRoutes(users: unknown[] = [ACTIVE_USER]) {
  return [{ path: "/users", body: { users, sod: [], serviceAccount: null } }];
}

describe("users screen", () => {
  it("keeps a disabled account visible and names its surviving sessions", async () => {
    const { fetchImpl } = stubFetch(usersRoutes([ACTIVE_USER, REVOKED_BUT_LIVE]));
    renderScreen(<UsersScreen />, { fetchImpl, session: ADMIN });

    // The revoked account must not disappear from the table — that is how a
    // still-authorised bearer goes unnoticed.
    expect(await screen.findByText("Baran Tunç")).toBeInTheDocument();
    expect(screen.getByText("pasif")).toBeInTheDocument();
    expect(screen.getByText(/2 oturum hâlâ açık/)).toBeInTheDocument();
  });

  it("warns before deactivating that open sessions must die too", async () => {
    const { fetchImpl } = stubFetch(usersRoutes());
    renderScreen(<UsersScreen />, { fetchImpl, session: ADMIN });

    await userEvent.click(await screen.findByRole("button", { name: "Pasifleştir" }));
    expect(await screen.findByText(/1 açık oturumu var/)).toBeInTheDocument();
  });

  it("requires a reason before it will deactivate an account", async () => {
    const { fetchImpl, calls } = stubFetch(usersRoutes());
    renderScreen(<UsersScreen />, { fetchImpl, session: ADMIN });

    await userEvent.click(await screen.findByRole("button", { name: "Pasifleştir" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Pasifleştir" }));

    expect(await screen.findByText("Gerekçe zorunlu.")).toBeInTheDocument();
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(0);
  });

  it("tells the operator when deactivation left sessions alive", async () => {
    const { fetchImpl } = stubFetch([
      ...usersRoutes(),
      {
        path: "/active",
        method: "PUT",
        body: { ...ACTIVE_USER, active: false, activeSessions: 3 },
      },
    ]);
    renderScreen(<UsersScreen />, { fetchImpl, session: ADMIN });

    await userEvent.click(await screen.findByRole("button", { name: "Pasifleştir" }));
    await userEvent.type(await screen.findByLabelText("Gerekçe"), "işten ayrıldı");
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Pasifleştir" }));

    expect(await screen.findByText(/3 oturum hâlâ açık görünüyor/)).toBeInTheDocument();
  });

  it("offers roles only from the closed set, never a free-text field", async () => {
    const { fetchImpl } = stubFetch(usersRoutes());
    renderScreen(<UsersScreen />, { fetchImpl, session: ADMIN });

    await userEvent.click(await screen.findByRole("button", { name: "Rolleri düzenle" }));
    const dialog = await screen.findByRole("dialog");

    for (const role of ["admin", "tech-lead", "product-owner", "qa", "developer", "viewer"]) {
      expect(within(dialog).getByLabelText(new RegExp(role))).toBeInstanceOf(HTMLInputElement);
    }
    // No text input for a role name anywhere in the dialog.
    expect(within(dialog).queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("falls back to viewer rather than an empty role list", async () => {
    const { fetchImpl, calls } = stubFetch([
      ...usersRoutes(),
      { path: "/roles", method: "PUT", body: { ...ACTIVE_USER, roles: ["viewer"] } },
    ]);
    renderScreen(<UsersScreen />, { fetchImpl, session: ADMIN });

    await userEvent.click(await screen.findByRole("button", { name: "Rolleri düzenle" }));
    const dialog = await screen.findByRole("dialog");
    // Clear the only granted role, then save.
    await userEvent.click(within(dialog).getByLabelText(/^qa/));
    expect(await screen.findByText(/salt-okunur \(viewer\) olarak kaydedilecek/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Kaydet" }));

    await waitFor(() => {
      const put = calls.find((call) => call.method === "PUT");
      expect(put?.body).toEqual({ roles: ["viewer"] });
    });
  });

  it("gives a non-admin no editing affordance at all", async () => {
    const { fetchImpl } = stubFetch(usersRoutes());
    renderScreen(<UsersScreen />, { fetchImpl, session: VIEWER });

    expect(await screen.findByText("salt-okunur")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pasifleştir" })).not.toBeInTheDocument();
  });

  it("gives a delegated admin no editing affordance either", async () => {
    const { fetchImpl } = stubFetch(usersRoutes());
    renderScreen(<UsersScreen />, { fetchImpl, session: DELEGATED_ADMIN });

    expect(await screen.findByText("salt-okunur")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Rolleri düzenle" })).not.toBeInTheDocument();
  });
});
