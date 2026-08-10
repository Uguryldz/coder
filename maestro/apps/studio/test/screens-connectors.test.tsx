import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ConnectorsPanel } from "../src/screens/settings/ConnectorsPanel.tsx";
import { ADMIN, VIEWER, renderScreen, stubFetch } from "./harness.tsx";

/**
 * The connector-management screen.
 *
 * The properties under test mirror what the BFF also enforces: an admin sees
 * the add/edit/test/delete controls and a viewer sees none; a saved token is
 * shown only as a mask; the live test calls the endpoint and renders the result
 * inline; and an edit that does not touch the token omits it from the payload
 * (so the stored credential is preserved).
 */

const GITHUB = {
  id: "github",
  kind: "github",
  displayName: "GitHub kurumsal",
  baseUrl: "https://api.github.com",
  authKind: "bearer",
  config: {},
  secretRef: "connector:github:abc",
  secretMask: "1234",
  secretSet: true,
  enabled: true,
  createdAt: "2026-08-10T09:00:00.000Z",
  updatedAt: "2026-08-10T09:00:00.000Z",
  lastTestedAt: null,
  lastTestOk: null,
};

const LIST = { path: "/studio/connections", body: { connections: [GITHUB] } };

describe("connectors panel", () => {
  it("lists connections and shows the token only as a mask (****abcd)", async () => {
    const { fetchImpl } = stubFetch([LIST]);
    renderScreen(<ConnectorsPanel />, { fetchImpl, session: ADMIN });

    expect(await screen.findByText("GitHub")).toBeInTheDocument();
    // The token is a mask, never the value.
    expect(screen.getByText("****1234")).toBeInTheDocument();
  });

  it("shows a tri-state status — never tested renders as ⚪, not a green light", async () => {
    const { fetchImpl } = stubFetch([LIST]);
    renderScreen(<ConnectorsPanel />, { fetchImpl, session: ADMIN });
    await screen.findByText("GitHub");
    expect(screen.getByText("test edilmedi")).toBeInTheDocument();
  });

  it("hides every write control from a viewer (M86)", async () => {
    const { fetchImpl } = stubFetch([LIST]);
    renderScreen(<ConnectorsPanel />, { fetchImpl, session: VIEWER });
    await screen.findByText("GitHub");
    expect(screen.queryByRole("button", { name: /Bağlantı ekle/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Test et/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sil" })).not.toBeInTheDocument();
  });

  it("runs a live test and renders the result inline", async () => {
    const { fetchImpl } = stubFetch([
      LIST,
      {
        path: "/studio/connections/github/test",
        method: "POST",
        body: { ok: true, messageKey: "connections.test.ok_as", messageParams: { who: "ugurbank-bot" }, testedAt: "2026-08-10T10:00:00.000Z" },
      },
    ]);
    renderScreen(<ConnectorsPanel />, { fetchImpl, session: ADMIN });
    await screen.findByText("GitHub");

    await userEvent.click(screen.getByRole("button", { name: /Test et/ }));
    // The catalog key is rendered in Turkish with the returned account name.
    expect(await screen.findByText("Bağlantı başarılı — ugurbank-bot")).toBeInTheDocument();
  });

  it("a config-only edit omits the token — the stored credential is preserved", async () => {
    const { fetchImpl, calls } = stubFetch([
      LIST,
      { path: "/studio/connections/github", method: "PUT", body: { connection: { ...GITHUB, displayName: "GitHub (prod)" } } },
    ]);
    renderScreen(<ConnectorsPanel />, { fetchImpl, session: ADMIN });
    await screen.findByText("GitHub");

    await userEvent.click(screen.getByRole("button", { name: "Düzenle" }));
    const dialog = await screen.findByRole("dialog");
    // The token field is LOCKED (shows the mask), not an input to prefill.
    expect(within(dialog).getByText("****1234")).toBeInTheDocument();

    const name = within(dialog).getByLabelText("Görünen ad");
    await userEvent.clear(name);
    await userEvent.type(name, "GitHub (prod)");
    await userEvent.click(within(dialog).getByRole("button", { name: "Düzenle" }));

    await waitFor(() => {
      const put = calls.find((c) => c.method === "PUT");
      expect(put).toBeDefined();
      // No token in the payload — the credential was not touched.
      expect((put?.body as { token?: string }).token).toBeUndefined();
      expect((put?.body as { displayName: string }).displayName).toBe("GitHub (prod)");
    });
  });

  it("creating a connection posts the typed fields including the token", async () => {
    const { fetchImpl, calls } = stubFetch([
      LIST,
      { path: "/studio/connections", method: "POST", status: 201, body: { connection: GITHUB } },
    ]);
    renderScreen(<ConnectorsPanel />, { fetchImpl, session: ADMIN });
    await screen.findByText("GitHub");

    await userEvent.click(screen.getByRole("button", { name: /Bağlantı ekle/ }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("Kimlik (id)"), "jira");
    await userEvent.type(within(dialog).getByLabelText("Görünen ad"), "Jira");
    await userEvent.type(within(dialog).getByLabelText(/URL/), "https://ugurbank.atlassian.net");
    await userEvent.type(within(dialog).getByLabelText("Token"), "s3cr3t-token");
    await userEvent.click(within(dialog).getByRole("button", { name: /Bağlantı ekle/ }));

    await waitFor(() => {
      const post = calls.find((c) => c.method === "POST");
      expect(post).toBeDefined();
      const body = post?.body as { id: string; token: string };
      expect(body.id).toBe("jira");
      expect(body.token).toBe("s3cr3t-token");
    });
  });
});
