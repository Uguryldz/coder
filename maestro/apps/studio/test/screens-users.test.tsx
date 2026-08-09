import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { UsersScreen } from "../src/screens/Users.tsx";
import { ADMIN, renderScreen, stubFetch } from "./harness.tsx";

const ACTIVE = {
  username: "deniz.yalcin",
  userId: "deniz.yalcin@ugurbank.local",
  roles: ["qa"],
  groups: ["maestro-ugurpay", "qa"],
  active: true,
};

const DISABLED = { ...ACTIVE, username: "baran.tunc", active: false };

describe("users screen", () => {
  it("does not query anything until a username is submitted", async () => {
    const { fetchImpl, calls } = stubFetch([{ path: "/studio/users/deniz.yalcin", body: ACTIVE }]);
    renderScreen(<UsersScreen />, { fetchImpl, session: ADMIN });

    await screen.findByLabelText("Kullanıcı adı");
    // An empty lookup would 404 on every render and teach the operator to
    // ignore the error.
    expect(calls).toHaveLength(0);
  });

  it("shows the directory's view of an account", async () => {
    const { fetchImpl } = stubFetch([{ path: "/studio/users/deniz.yalcin", body: ACTIVE }]);
    renderScreen(<UsersScreen />, { fetchImpl, session: ADMIN });

    await userEvent.type(await screen.findByLabelText("Kullanıcı adı"), "deniz.yalcin");
    await userEvent.click(screen.getByRole("button", { name: "Sorgula" }));

    expect(await screen.findByText("deniz.yalcin@ugurbank.local")).toBeInTheDocument();
    expect(screen.getByText("etkin")).toBeInTheDocument();
  });

  it("warns that a disabled account's issued tokens can outlive the revocation", async () => {
    const { fetchImpl } = stubFetch([{ path: "/studio/users/baran.tunc", body: DISABLED }]);
    renderScreen(<UsersScreen />, { fetchImpl, session: ADMIN });

    await userEvent.type(await screen.findByLabelText("Kullanıcı adı"), "baran.tunc");
    await userEvent.click(screen.getByRole("button", { name: "Sorgula" }));

    expect(await screen.findByText("pasif")).toBeInTheDocument();
    // The account being disabled is NOT the same as its sessions being dead.
    expect(screen.getByText(/süresi dolana kadar geçerli kalabilir/)).toBeInTheDocument();
  });

  it("offers no role editing at all — the directory owns authority", async () => {
    const { fetchImpl } = stubFetch([{ path: "/studio/users/deniz.yalcin", body: ACTIVE }]);
    renderScreen(<UsersScreen />, { fetchImpl, session: ADMIN });

    await userEvent.type(await screen.findByLabelText("Kullanıcı adı"), "deniz.yalcin");
    await userEvent.click(screen.getByRole("button", { name: "Sorgula" }));
    await screen.findByText("deniz.yalcin@ugurbank.local");

    // No mutation affordance may exist: there is no endpoint behind one, and a
    // button implying Studio can revoke access would be a lie.
    expect(screen.queryByRole("button", { name: "Pasifleştir" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Rolleri düzenle" })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.getByText(/Roller Maestro'da verilmez/)).toBeInTheDocument();
  });

  it("lists the closed role set as a legend", async () => {
    const { fetchImpl } = stubFetch([]);
    renderScreen(<UsersScreen />, { fetchImpl, session: ADMIN });

    for (const role of ["admin", "tech-lead", "product-owner", "qa", "developer", "viewer"]) {
      expect(await screen.findByText(role)).toBeInTheDocument();
    }
  });

  it("shows a translated failure, never the server code, for an unknown user", async () => {
    const { fetchImpl } = stubFetch([
      { path: "/studio/users/nobody", status: 404, body: { error: "unknown_user" } },
    ]);
    renderScreen(<UsersScreen />, { fetchImpl, session: ADMIN });

    await userEvent.type(await screen.findByLabelText("Kullanıcı adı"), "nobody");
    await userEvent.click(screen.getByRole("button", { name: "Sorgula" }));

    expect(await screen.findByText("Veri alınamadı")).toBeInTheDocument();
    expect(screen.queryByText(/unknown_user/)).not.toBeInTheDocument();
  });
});
