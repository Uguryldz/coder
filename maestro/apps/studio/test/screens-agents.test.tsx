import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { KnowledgeScreen } from "../src/screens/Knowledge.tsx";
import { VariantsScreen } from "../src/screens/Variants.tsx";
import { VariantScreen } from "../src/screens/Variant.tsx";
import { isValidPersona, isValidVariantId } from "../src/screens/variants/validate.ts";
import { ADMIN, VIEWER, renderScreen, stubFetch } from "./harness.tsx";

/**
 * The agent screens: the definitions list, one definition's detail, and the
 * learning-notes library.
 *
 * The properties under test are the ones the BFF also enforces, mirrored so a
 * UI that drifted from the server fails here: only an admin sees the write
 * controls, a create posts the fields the admin typed, a version publish sends
 * only versioned fields, and the form refuses what the server would refuse —
 * BEFORE the request, with the field named.
 */

const VARIANTS_LIST = {
  path: "/variants",
  body: {
    variants: [
      {
        variantId: "analyst-web",
        role: "analyst",
        platform: "Analiz ajanı (varsayılan)",
        model: "claude-opus-5",
        activeVersion: 2,
      },
    ],
  },
};

describe("variants screen", () => {
  it("lists the catalogue: the agent's NAME (wire `platform`) is a column, not a 'platform'", async () => {
    const { fetchImpl } = stubFetch([VARIANTS_LIST]);
    renderScreen(<VariantsScreen />, { fetchImpl, session: ADMIN });
    expect(await screen.findByText("analyst-web")).toBeInTheDocument();
    expect(screen.getByText("Analiz ajanı (varsayılan)")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Ajan adı" })).toBeInTheDocument();
    expect(screen.queryByText("Platform")).not.toBeInTheDocument();
    // No quality score / knowledge-file count columns — nothing produces them.
    expect(screen.queryByText("Kalite skoru")).not.toBeInTheDocument();
    expect(screen.queryByText("Bilgi kaynağı")).not.toBeInTheDocument();
  });

  it("hides the add button from a non-admin", async () => {
    const { fetchImpl } = stubFetch([VARIANTS_LIST]);
    renderScreen(<VariantsScreen />, { fetchImpl, session: VIEWER });
    await screen.findByText("analyst-web");
    expect(screen.queryByRole("button", { name: "Ajan tanımı ekle" })).not.toBeInTheDocument();
  });

  it("creates an agent, posting the typed fields (name travels as `platform`; never a forged author)", async () => {
    const { fetchImpl, calls } = stubFetch([
      VARIANTS_LIST,
      {
        path: "/variants",
        method: "POST",
        status: 201,
        body: { variantId: "engineer-mobile", role: "engineer", platform: "Mobil geliştirici", activeVersion: 1 },
      },
    ]);
    renderScreen(<VariantsScreen />, { fetchImpl, session: ADMIN });

    await userEvent.click(await screen.findByRole("button", { name: "Ajan tanımı ekle" }));
    const dialog = await screen.findByRole("dialog");

    await userEvent.type(within(dialog).getByLabelText("Ajan adı"), "Mobil geliştirici");
    await userEvent.type(within(dialog).getByLabelText("Kimlik"), "engineer-mobile");
    await userEvent.selectOptions(within(dialog).getByLabelText("Rol"), "engineer");
    await userEvent.type(within(dialog).getByLabelText("Model"), "claude-opus-5");
    await userEvent.click(within(dialog).getByRole("button", { name: "Ajan tanımı ekle" }));

    await waitFor(() => {
      const post = calls.find((call) => call.method === "POST");
      expect(post).toBeDefined();
      expect(post?.body).toMatchObject({
        variantId: "engineer-mobile",
        role: "engineer",
        platform: "Mobil geliştirici",
        model: "claude-opus-5",
      });
      // The author is derived server-side from the session; the client never sends it.
      expect(post?.body).not.toHaveProperty("publishedBy");
    });
  });

  it("offers the four chain roles (analyst, planner, engineer, verifier) — no disabled 'coming soon' rows", async () => {
    const { fetchImpl } = stubFetch([VARIANTS_LIST]);
    renderScreen(<VariantsScreen />, { fetchImpl, session: ADMIN });

    await userEvent.click(await screen.findByRole("button", { name: "Ajan tanımı ekle" }));
    const dialog = await screen.findByRole("dialog");
    const role = within(dialog).getByLabelText("Rol");
    const options = within(role).getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "analist",
      "plancı",
      "geliştirici",
      "doğrulayıcı (kod gözden geçiren)",
    ]);
    expect(within(dialog).queryByText(/yakında/)).not.toBeInTheDocument();
  });

  it("refuses an over-long name and a bad id BEFORE sending, naming the field", async () => {
    const { fetchImpl, calls } = stubFetch([VARIANTS_LIST]);
    renderScreen(<VariantsScreen />, { fetchImpl, session: ADMIN });

    await userEvent.click(await screen.findByRole("button", { name: "Ajan tanımı ekle" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("Ajan adı"), "a".repeat(65));
    await userEvent.type(within(dialog).getByLabelText("Kimlik"), "Büyük Harf");
    await userEvent.click(within(dialog).getByRole("button", { name: "Ajan tanımı ekle" }));

    expect(await within(dialog).findByText("Ajan adı gerekli; en çok 64 karakter.")).toBeInTheDocument();
    expect(within(dialog).getByText(/Kimlik küçük harf/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Bir model seçin/)).toBeInTheDocument();
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });
});

/** A detail with an active version 2 on `claude-opus-5`. */
const VARIANT_DETAIL = {
  path: "/variants/analyst-web",
  body: {
    variantId: "analyst-web",
    role: "analyst",
    platform: "Analiz ajanı (varsayılan)",
    model: "claude-opus-5",
    activeVersion: 2,
    persona: "mevcut persona",
    knowledge: [],
    versions: [
      { version: 2, publishedAt: "2026-07-20T09:00:00.000Z", publishedBy: "ayse@ugurbank.local", note: "v2", evalScore: null },
      { version: 1, publishedAt: "2026-07-01T09:00:00.000Z", publishedBy: "ayse@ugurbank.local", note: "ilk", evalScore: null },
    ],
  },
};
const GUIDANCE_EMPTY = { path: "/studio/guidance", body: { notes: [] } };

describe("variant detail screen", () => {
  it("has a way back and shows role + model above the tabs", async () => {
    const { fetchImpl } = stubFetch([VARIANT_DETAIL, GUIDANCE_EMPTY]);
    renderScreen(<VariantScreen />, {
      fetchImpl,
      session: VIEWER,
      initialEntries: ["/variants/detail?id=analyst-web"],
    });
    expect(await screen.findByRole("heading", { name: "Analiz ajanı (varsayılan)" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "← Ajan tanımları" })).toHaveAttribute("href", "/variants");
    expect(screen.getByText("analist")).toBeInTheDocument();
    expect(screen.getByText("claude-opus-5")).toBeInTheDocument();
    expect(screen.getByDisplayValue("mevcut persona")).toBeInTheDocument();
  });

  it("hides the write buttons from a non-admin", async () => {
    const { fetchImpl } = stubFetch([VARIANT_DETAIL, GUIDANCE_EMPTY]);
    renderScreen(<VariantScreen />, {
      fetchImpl,
      session: VIEWER,
      initialEntries: ["/variants/detail?id=analyst-web"],
    });
    await screen.findByDisplayValue("mevcut persona");
    expect(screen.queryByRole("button", { name: "Yeni sürüm yayınla" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Adı düzenle" })).not.toBeInTheDocument();
  });

  it("an unknown id shows the not-found error, not a blank page", async () => {
    const { fetchImpl } = stubFetch([
      { path: "/variants/yok", status: 404, body: { error: "unknown_variant" } },
      GUIDANCE_EMPTY,
    ]);
    renderScreen(<VariantScreen />, {
      fetchImpl,
      session: ADMIN,
      initialEntries: ["/variants/detail?id=yok"],
    });
    expect(await screen.findByText("Böyle bir variant yok.")).toBeInTheDocument();
  });

  it("without ?id= says so instead of picking one", async () => {
    const { fetchImpl } = stubFetch([GUIDANCE_EMPTY]);
    renderScreen(<VariantScreen />, { fetchImpl, session: ADMIN, initialEntries: ["/variants/detail"] });
    expect(await screen.findByText("Önce bir ajan tanımı seçin")).toBeInTheDocument();
  });

  it("publishes a new version with a different model, posting only versioned fields (M83)", async () => {
    const { fetchImpl, calls } = stubFetch([
      VARIANT_DETAIL,
      GUIDANCE_EMPTY,
      {
        path: "/variants/analyst-web/versions",
        method: "POST",
        status: 201,
        body: { ...VARIANT_DETAIL.body, model: "claude-sonnet-5", activeVersion: 3 },
      },
    ]);
    renderScreen(<VariantScreen />, {
      fetchImpl,
      session: ADMIN,
      initialEntries: ["/variants/detail?id=analyst-web"],
    });

    await userEvent.click(await screen.findByRole("button", { name: "Yeni sürüm yayınla" }));
    const dialog = await screen.findByRole("dialog");

    const model = within(dialog).getByLabelText("Model");
    await userEvent.clear(model);
    await userEvent.type(model, "claude-sonnet-5");
    await userEvent.type(within(dialog).getByLabelText("Sürüm notu"), "model yükseltildi");
    await userEvent.click(within(dialog).getByRole("button", { name: "Yeni sürüm yayınla" }));

    await waitFor(() => {
      const post = calls.find((call) => call.url.includes("/versions"));
      expect(post).toBeDefined();
      expect(post?.method).toBe("POST");
      expect(post?.body).toMatchObject({ model: "claude-sonnet-5", note: "model yükseltildi" });
      expect(post?.body).not.toHaveProperty("version");
      expect(post?.body).not.toHaveProperty("publishedBy");
      expect(post?.body).not.toHaveProperty("publishedAt");
    });
  });

  it("edits the NAME in place (PUT platform) and says so", async () => {
    const { fetchImpl, calls } = stubFetch([
      VARIANT_DETAIL,
      GUIDANCE_EMPTY,
      { path: "/variants/analyst-web", method: "PUT", body: { ...VARIANT_DETAIL.body, platform: "Kredi analisti" } },
    ]);
    renderScreen(<VariantScreen />, {
      fetchImpl,
      session: ADMIN,
      initialEntries: ["/variants/detail?id=analyst-web"],
    });

    await userEvent.click(await screen.findByRole("button", { name: "Adı düzenle" }));
    const dialog = await screen.findByRole("dialog");
    const name = within(dialog).getByLabelText("Ajan adı");
    await userEvent.clear(name);
    await userEvent.type(name, "Kredi analisti");
    await userEvent.click(within(dialog).getByRole("button", { name: "Kaydet" }));

    await waitFor(() => {
      const put = calls.find((call) => call.method === "PUT");
      expect(put?.body).toEqual({ platform: "Kredi analisti" });
    });
    expect(await screen.findByText("Ajan adı güncellendi.")).toBeInTheDocument();
  });
});

describe("knowledge screen — learning notes", () => {
  const NOTES = [
    { id: "ag_1", title: "genel-kural.md", content: "herkese ".repeat(40), enabled: true, updatedAt: "2026-08-14T10:00:00.000Z", variantId: null },
    { id: "ag_2", title: "web-ozel.md", content: "yalnız web", enabled: false, updatedAt: "2026-08-14T11:00:00.000Z", variantId: "analyst-web" },
  ];

  it("lists notes with their scope, content shortened", async () => {
    const { fetchImpl } = stubFetch([{ path: "/studio/guidance", body: { notes: NOTES } }, VARIANTS_LIST]);
    renderScreen(<KnowledgeScreen />, { fetchImpl, session: VIEWER });

    expect(await screen.findByText("genel-kural.md")).toBeInTheDocument();
    expect(screen.getByText("tüm ajanlar")).toBeInTheDocument();
    expect(screen.getByText("yalnız: analyst-web")).toBeInTheDocument();
    // 320 characters of content do not land in the cell as-is.
    const cell = screen.getByText(/^herkese herkese/);
    expect(cell.textContent?.length).toBeLessThan(160);
    expect(cell.textContent?.endsWith("…")).toBe(true);
    // No search box: nothing writes the table it searched.
    expect(screen.queryByLabelText("Ara")).not.toBeInTheDocument();
  });

  it("a typed note can target ONE agent — the select is fed from /variants", async () => {
    const { fetchImpl, calls } = stubFetch([
      { path: "/studio/guidance", body: { notes: [] } },
      VARIANTS_LIST,
      { path: "/studio/guidance", method: "POST", status: 201, body: { note: { ...NOTES[1], id: "ag_9" } } },
    ]);
    renderScreen(<KnowledgeScreen />, { fetchImpl, session: ADMIN });

    await userEvent.type(await screen.findByLabelText("Başlık"), "Web kuralı");
    await userEvent.type(screen.getByLabelText("İçerik"), "yalnız web");
    await userEvent.selectOptions(
      await screen.findByLabelText("Ajan"),
      await screen.findByRole("option", { name: "Analiz ajanı (varsayılan) · analyst-web" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Ekle" }));

    await waitFor(() => {
      const post = calls.find((call) => call.method === "POST" && call.url.endsWith("/studio/guidance"));
      expect(post?.body).toMatchObject({ title: "Web kuralı", content: "yalnız web", variantId: "analyst-web" });
    });
  });

  it("toggling reports what it did", async () => {
    const { fetchImpl } = stubFetch([
      { path: "/studio/guidance", body: { notes: NOTES } },
      VARIANTS_LIST,
      { path: "/studio/guidance/ag_2", method: "PUT", body: { note: { ...NOTES[1], enabled: true } } },
    ]);
    renderScreen(<KnowledgeScreen />, { fetchImpl, session: ADMIN });

    await userEvent.click(await screen.findByRole("button", { name: "web-ozel.md notunu etkinleştir" }));
    expect(await screen.findByText("Not etkin — yeni analizlerde dikkate alınacak.")).toBeInTheDocument();
  });
});

describe("variant form limits (the BFF's, mirrored)", () => {
  it("id: lower-case, dashes, at most 64", () => {
    expect(isValidVariantId("kredi-analisti")).toBe(true);
    expect(isValidVariantId("Kredi")).toBe(false);
    expect(isValidVariantId("-kredi")).toBe(false);
    expect(isValidVariantId("a".repeat(65))).toBe(false);
  });

  it("persona: at most 20 000 characters, tab/newline allowed, other control chars not", () => {
    expect(isValidPersona("satır\n\tsatır")).toBe(true);
    expect(isValidPersona("x".repeat(20_001))).toBe(false);
    expect(isValidPersona("kötü [0m")).toBe(false);
  });
});
