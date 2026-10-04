import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "../src/app/ErrorBoundary.tsx";
import { SCREENS } from "../src/app/screens.ts";
import { Sidebar } from "../src/shell/Sidebar.tsx";
import { TopBar } from "../src/shell/TopBar.tsx";
import { ADMIN, VIEWER, renderScreen, stubFetch } from "./harness.tsx";

/**
 * The chrome: a menu that shows only what the session may use, a top bar that
 * says which role that is, and a per-screen error boundary that lets go of a
 * broken screen when the operator navigates away.
 */

describe("sidebar", () => {
  it("has no 'yakında' entry — either a screen has data or it is not a screen", () => {
    const { fetchImpl } = stubFetch([]);
    renderScreen(<Sidebar />, { fetchImpl });
    expect(screen.queryByText("yakında")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Sürüm kalite testi/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Güvenlik taramaları/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Çalışan makineler/ })).not.toBeInTheDocument();
  });

  it("shows an admin every group, in operator order", () => {
    const { fetchImpl } = stubFetch([]);
    renderScreen(<Sidebar />, { fetchImpl, session: ADMIN });
    const groups = [...document.querySelectorAll(".shell__navgroup")].map((el) => el.textContent);
    expect(groups).toEqual(["İşler", "Ajanlar", "Projeler", "Denetim", "Yönetim", "Yardım"]);
    expect(screen.getByRole("link", { name: /Kullanıcılar/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Bağlantılar/ })).toBeInTheDocument();
  });

  it("hides from a viewer every entry whose endpoint would only 403", () => {
    const { fetchImpl } = stubFetch([]);
    renderScreen(<Sidebar />, { fetchImpl, session: VIEWER });
    // Still there: the daily list, the agents, the projects, evidence, help.
    expect(screen.getByRole("link", { name: /Panel/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Ajan tanımları/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Kanıt paketi/ })).toBeInTheDocument();
    // Gone: everything admin / tech-lead only — and the whole Yönetim group with it.
    expect(screen.queryByRole("link", { name: /Kullanıcılar/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Denetim izi/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Sistem sağlığı/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Yönetim")).not.toBeInTheDocument();
  });

  it("lists every navigable screen exactly once for an admin", () => {
    const { fetchImpl } = stubFetch([]);
    renderScreen(<Sidebar />, { fetchImpl, session: ADMIN });
    const expected = SCREENS.filter((row) => row.navKey !== undefined).length;
    expect(screen.getAllByRole("link")).toHaveLength(expected);
  });
});

describe("top bar", () => {
  it("shows the session's role beside the user name", () => {
    const { fetchImpl } = stubFetch([]);
    renderScreen(<TopBar title="Panel" />, { fetchImpl, session: ADMIN });
    const user = screen.getByText("ugur.yildiz");
    expect(user).toBeInTheDocument();
    expect(user).toHaveTextContent("admin");
    expect(user).toHaveAttribute("title", "Rol: admin");
  });

  it("offers the menu toggle only when the shell says the sidebar is a drawer", () => {
    const { fetchImpl } = stubFetch([]);
    const onToggleNav = vi.fn();
    renderScreen(<TopBar title="Panel" onToggleNav={onToggleNav} />, { fetchImpl });
    expect(screen.getByRole("button", { name: "Menüyü aç" })).toHaveAttribute("aria-expanded", "false");
  });
});

function Boom(): ReactNode {
  throw new Error("kaboom");
}

describe("per-screen ErrorBoundary", () => {
  it("clears a caught error when its reset key changes, and offers a way back", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const onBack = vi.fn();
    const labels = { title: "Ekran çizilemedi", hint: "Başka bir ekrana geç.", back: "Geri dön" };

    function Harness(): ReactNode {
      return (
        <MemoryRouter initialEntries={["/broken"]}>
          <Routes>
            <Route
              path="*"
              element={
                <ErrorBoundary resetKey="broken" labels={labels} onBack={onBack}>
                  <Boom />
                </ErrorBoundary>
              }
            />
          </Routes>
        </MemoryRouter>
      );
    }
    const { rerender } = render(<Harness />);
    expect(screen.getByRole("alert")).toHaveTextContent("Ekran çizilemedi");

    await userEvent.click(screen.getByRole("button", { name: "Geri dön" }));
    expect(onBack).toHaveBeenCalledOnce();

    // The same boundary with a NEW key and healthy children: the panel is gone.
    rerender(
      <MemoryRouter initialEntries={["/fine"]}>
        <Routes>
          <Route
            path="*"
            element={
              <ErrorBoundary resetKey="fine" labels={labels} onBack={onBack}>
                <p>sağlıklı ekran</p>
              </ErrorBoundary>
            }
          />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("sağlıklı ekran")).toBeInTheDocument();
    spy.mockRestore();
  });
});
