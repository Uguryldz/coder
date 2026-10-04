import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { VariantScreen } from "../src/screens/Variant.tsx";
import { ADMIN, VIEWER, renderScreen, stubFetch } from "./harness.tsx";

/**
 * The agent-targeted knowledge upload (Variant → "Bilgi notları" tab). A document
 * uploaded HERE must carry `variantId` — that is the whole point: the note
 * feeds ONE agent, unlike the Knowledge screen's global upload. And the list
 * under the button shows ONLY this agent's notes, not the global ones and not
 * another agent's.
 */

const DETAIL = {
  path: "/variants/analyst-web",
  body: {
    variantId: "analyst-web",
    role: "analyst",
    platform: "web",
    model: "claude-opus-5",
    activeVersion: 2,
    persona: "mevcut persona",
    versions: [],
  },
};

/** Global note + a note for THIS agent + a note for ANOTHER agent. */
const NOTES = [
  { id: "ag_1", title: "genel-kural.md", content: "herkese", enabled: true, updatedAt: "2026-08-14T10:00:00.000Z", variantId: null },
  { id: "ag_2", title: "web-ozel.md", content: "yalnız web", enabled: true, updatedAt: "2026-08-14T11:00:00.000Z", variantId: "analyst-web" },
  { id: "ag_3", title: "mobil-ozel.md", content: "yalnız mobil", enabled: false, updatedAt: "2026-08-14T12:00:00.000Z", variantId: "engineer-mobile" },
];

const ROUTES = [
  DETAIL,
  { path: "/studio/guidance", body: { notes: NOTES } },
  {
    path: "/studio/guidance/upload",
    method: "POST",
    status: 201,
    body: { note: { id: "ag_9", title: "yeni.md", content: "x", enabled: true, updatedAt: "2026-08-15T09:00:00.000Z", variantId: "analyst-web" } },
  },
] as const;

/** Fire the hidden file input directly (display:none defeats user-event). */
function chooseFile(file: File): void {
  const input = document.querySelector('input[type="file"]');
  expect(input).not.toBeNull();
  fireEvent.change(input as HTMLInputElement, { target: { files: [file] } });
}

async function openKnowledgeTab(): Promise<void> {
  await userEvent.click(await screen.findByRole("tab", { name: /Bilgi notları/ }));
}

describe("variant detail — knowledge tab, targeted guidance", () => {
  it("lists ONLY this agent's notes — global and other-agent notes stay out", async () => {
    const { fetchImpl } = stubFetch([...ROUTES]);
    renderScreen(<VariantScreen />, {
      fetchImpl,
      session: ADMIN,
      initialEntries: ["/variants/detail?id=analyst-web"],
    });

    await openKnowledgeTab();
    expect(await screen.findByText("web-ozel.md")).toBeInTheDocument();
    expect(screen.queryByText("genel-kural.md")).not.toBeInTheDocument();
    expect(screen.queryByText("mobil-ozel.md")).not.toBeInTheDocument();
  });

  it("counts the targeted notes into the Knowledge tab badge", async () => {
    const { fetchImpl } = stubFetch([...ROUTES]);
    renderScreen(<VariantScreen />, {
      fetchImpl,
      session: ADMIN,
      initialEntries: ["/variants/detail?id=analyst-web"],
    });

    // Exactly the one note targeted at this agent.
    const tab = await screen.findByRole("tab", { name: /Bilgi notları/ });
    await waitFor(() => expect(tab).toHaveTextContent("Bilgi notları1"));
  });

  it("uploads a document WITH this variant’s id, and mirrors nowhere else", async () => {
    const { fetchImpl, calls } = stubFetch([...ROUTES]);
    renderScreen(<VariantScreen />, {
      fetchImpl,
      session: ADMIN,
      initialEntries: ["/variants/detail?id=analyst-web"],
    });

    await openKnowledgeTab();
    await screen.findByRole("button", { name: "Bu ajana belge yükle" });
    chooseFile(new File(["# Kural\nWeb ajanına özel."], "yeni.md", { type: "text/markdown" }));

    await waitFor(() => {
      const post = calls.find(
        (call) => call.url.endsWith("/studio/guidance/upload") && call.method === "POST",
      );
      expect(post).toBeDefined();
      // The target travels with the file — this is what makes it agent-scoped.
      expect(post?.body).toMatchObject({ fileName: "yeni.md", variantId: "analyst-web" });
    });

    // The write used to be mirrored into the running pilot. That engine is
    // retired, and a call to it now would be a request to nothing.
    expect(calls.some((call) => call.url.includes("/studio/pilot/"))).toBe(false);
  });

  it("deleting asks first and names the note; confirming sends the DELETE", async () => {
    const { fetchImpl, calls } = stubFetch([
      ...ROUTES,
      { path: "/studio/guidance/ag_2", method: "DELETE", status: 204, body: null },
    ]);
    renderScreen(<VariantScreen />, {
      fetchImpl,
      session: ADMIN,
      initialEntries: ["/variants/detail?id=analyst-web"],
    });

    await openKnowledgeTab();
    await screen.findByText("web-ozel.md");
    await userEvent.click(screen.getByRole("button", { name: "Sil" }));
    // Nothing is sent by the first click — the dialog asks.
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/"web-ozel.md" silinecek/)).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole("button", { name: "Sil" }));
    await waitFor(() => {
      expect(calls.some((call) => call.method === "DELETE" && call.url.endsWith("/studio/guidance/ag_2"))).toBe(true);
    });
  });

  it("a failed toggle shows the SERVER's reason, not a fixed sentence", async () => {
    const { fetchImpl } = stubFetch([
      ...ROUTES,
      { path: "/studio/guidance/ag_2", method: "PUT", status: 404, body: { error: "no_such_guidance" } },
    ]);
    renderScreen(<VariantScreen />, {
      fetchImpl,
      session: ADMIN,
      initialEntries: ["/variants/detail?id=analyst-web"],
    });

    await openKnowledgeTab();
    await screen.findByText("web-ozel.md");
    await userEvent.click(screen.getByRole("button", { name: "web-ozel.md notunu kapat" }));
    expect(await screen.findByText("Böyle bir öğrenme notu yok.")).toBeInTheDocument();
  });

  it("hides the upload button and actions from a viewer (write is admin/tech-lead)", async () => {
    const { fetchImpl } = stubFetch([...ROUTES]);
    renderScreen(<VariantScreen />, {
      fetchImpl,
      session: VIEWER,
      initialEntries: ["/variants/detail?id=analyst-web"],
    });

    await openKnowledgeTab();
    await screen.findByText("web-ozel.md");
    expect(screen.queryByRole("button", { name: "Bu ajana belge yükle" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sil" })).not.toBeInTheDocument();
  });
});
