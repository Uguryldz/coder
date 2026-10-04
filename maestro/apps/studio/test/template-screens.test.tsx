import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, type ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../src/auth/AuthProvider.tsx";
import type { Session } from "../src/auth/types.ts";
import { I18nProvider } from "../src/i18n/I18nProvider.tsx";
import { DoctemplateScreen } from "../src/screens/Doctemplate.tsx";
import { TemplateScreen } from "../src/screens/Template.tsx";
import { ToastProvider } from "../src/ui/index.ts";

/**
 * The two template screens: the analysis template designer and the Word
 * template. Both talk to the BFF through the ApiClient only — every test
 * injects its own fetch stub (test/setup.ts makes the global fetch throw).
 */

const user = userEvent.setup({ delay: null });

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sessionWith(roles: readonly string[]): Session {
  return {
    userId: "u1",
    username: "test@corp",
    roles,
    groups: [],
    delegated: false,
    expiresAt: "2026-08-09T23:00:00Z",
  };
}

function renderScreen(ui: ReactNode, fetchImpl: typeof fetch, session = sessionWith(["admin"])): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <StrictMode>
      <I18nProvider initialLocale="tr" storage={undefined}>
        <QueryClientProvider client={queryClient}>
          <AuthProvider fetchImpl={fetchImpl} initialSession={session} initialToken="test-token">
            <ToastProvider>
              <MemoryRouter>{ui}</MemoryRouter>
            </ToastProvider>
          </AuthProvider>
        </QueryClientProvider>
      </I18nProvider>
    </StrictMode>,
  );
}

const SECTION = {
  key: "amac",
  title: "Amaç",
  description: "",
  aiInstruction: "Amacı özetle.",
  required: true,
  format: "free_text",
  example: "",
};

const PUBLISHED = {
  template: { name: "Kurumsal analiz şablonu", version: 3, sections: [SECTION] },
  history: [],
  projects: [],
};

describe("TemplateScreen — first template on an empty installation", () => {
  /**
   * `GET /template` answers 404 `no_template` until someone publishes. That is
   * not a failure of the screen; it is the state the screen exists to end. The
   * screen offers to create the first template, and the first publish becomes
   * version 1 — after which the server copy re-seeds the draft.
   */
  it("offers to create the first template and publishes it as version 1", async () => {
    let published: unknown = null;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/template/versions") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as {
          name: string;
          sections: readonly unknown[];
        };
        published = { name: body.name, version: 1, sections: body.sections };
        return json(published, 201);
      }
      if (url.includes("/template")) {
        return published === null
          ? json({ error: "no_template" }, 404)
          : json({ template: published, history: [], projects: [] });
      }
      return json({ error: "not_found" }, 404);
    }) as unknown as typeof fetch;

    renderScreen(<TemplateScreen />, fetchImpl);

    // Not an error panel: a first-run offer.
    expect(await screen.findByText("Henüz analiz şablonu yok")).toBeInTheDocument();
    expect(screen.queryByText("Veri alınamadı")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "İlk şablonu oluştur" }));

    // The seeded draft: a name and one section, ready to edit.
    expect(await screen.findByLabelText("Şablon adı")).toHaveValue("Kurumsal analiz şablonu");
    expect(within(screen.getByRole("list")).getByText("Amaç")).toBeInTheDocument();

    const publish = screen.getByRole("button", { name: "İlk sürümü yayınla" });
    expect(publish).toBeEnabled();
    await user.click(publish);

    await waitFor(() => expect(published).not.toBeNull());
    expect(published).toMatchObject({ name: "Kurumsal analiz şablonu", version: 1 });
    expect((published as { sections: readonly unknown[] }).sections).toHaveLength(1);

    // The server copy came back as v1 and the draft is clean again.
    expect(await screen.findByText("sürüm v1")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Yeni sürüm olarak yayınla" })).toBeDisabled(),
    );
  });

  it("still shows a plain 404 as the not-found error", async () => {
    const fetchImpl = vi.fn(async () => json({ error: "not_found" }, 404)) as unknown as typeof fetch;
    renderScreen(<TemplateScreen />, fetchImpl);
    expect(await screen.findByText("Kayıt bulunamadı.")).toBeInTheDocument();
    expect(screen.queryByText("İlk şablonu oluştur")).not.toBeInTheDocument();
  });
});

describe("TemplateScreen — publish only when something changed", () => {
  /**
   * A publish always creates a NEW version, so publishing an unchanged draft
   * is not harmless: it bumps the version and writes an empty audit entry. The
   * button therefore follows the draft: disabled while identical to the
   * published copy, enabled once it differs, disabled again when the change is
   * undone.
   */
  it("disables the publish button until the draft differs from the published version", async () => {
    const fetchImpl = vi.fn(async () => json(PUBLISHED)) as unknown as typeof fetch;
    renderScreen(<TemplateScreen />, fetchImpl);
    await screen.findByText("Amaç");

    const publish = screen.getByRole("button", { name: "Yeni sürüm olarak yayınla" });
    expect(publish).toBeDisabled();
    expect(screen.queryByText("yayınlanmamış değişiklik")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "+ Bölüm ekle" }));
    expect(publish).toBeEnabled();
    expect(screen.getByText("yayınlanmamış değişiklik")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: '"Yeni bölüm" bölümünü çıkar' }));
    expect(publish).toBeDisabled();
    expect(screen.queryByText("yayınlanmamış değişiklik")).not.toBeInTheDocument();
  });

  it("renaming the template counts as a change", async () => {
    const fetchImpl = vi.fn(async () => json(PUBLISHED)) as unknown as typeof fetch;
    renderScreen(<TemplateScreen />, fetchImpl);
    await screen.findByText("Amaç");

    await user.type(screen.getByLabelText("Şablon adı"), " v2");
    expect(screen.getByRole("button", { name: "Yeni sürüm olarak yayınla" })).toBeEnabled();
  });
});

const NO_DOC_TEMPLATE = {
  template: null,
  placeholders: [],
  sectionMapping: [
    { index: 1, title: "Amaç", token: "{{bolum:1}}", mapped: false },
    { index: 2, title: "Kapsam", token: "{{bolum:2}}", mapped: false },
  ],
  outputs: [],
};

const DOC_TEMPLATE = {
  template: {
    fileName: "kurumsal.docx",
    version: 2,
    uploadedAt: "2026-09-01T10:00:00Z",
    uploadedBy: "admin",
    sizeBytes: 20480,
    styles: ["Başlık 1"],
  },
  placeholders: [
    { token: "{{baslik}}", descriptionKey: "doctemplate.what.title", location: "Kapak", found: true },
    { token: "{{yeni}}", descriptionKey: "doctemplate.what.does_not_exist", location: "", found: false },
    { token: "{{bolum:1}}", descriptionKey: "doctemplate.what.section", location: "Sayfa 2", found: true },
  ],
  sectionMapping: [
    { index: 1, title: "Amaç", token: "{{bolum:1}}", mapped: true },
    { index: 2, title: "Kapsam", token: "{{bolum:2}}", mapped: false },
  ],
  outputs: [{ fileName: "PAY-101-analiz.docx", at: "2026-09-02T08:00:00Z", templateVersion: 2 }],
};

describe("DoctemplateScreen", () => {
  it("does not claim 'all found' when no template has been uploaded", async () => {
    renderScreen(<DoctemplateScreen />, vi.fn(async () => json(NO_DOC_TEMPLATE)) as unknown as typeof fetch);

    expect(await screen.findByText("şablon yok")).toBeInTheDocument();
    expect(screen.queryByText("hepsi şablonda bulundu")).not.toBeInTheDocument();
    expect(screen.getByText(/Şablon yüklenince tarama sonucu burada görünür/)).toBeInTheDocument();
    // Every section is appended at the end until a template carries its slot.
    expect(screen.getAllByText("sona eklenecek")).toHaveLength(2);
    expect(screen.getByText("1. bölüm — Amaç")).toBeInTheDocument();
  });

  it("merges placeholders and section slots into one table and survives an unknown description key", async () => {
    renderScreen(<DoctemplateScreen />, vi.fn(async () => json(DOC_TEMPLATE)) as unknown as typeof fetch);

    expect(await screen.findByText("kurumsal.docx")).toBeInTheDocument();
    // Fixed placeholders: translated description, or a marked raw key — never a throw.
    expect(screen.getByText("Doküman başlığı")).toBeInTheDocument();
    expect(screen.getByText("tanınmayan: doctemplate.what.does_not_exist")).toBeInTheDocument();
    // A section slot appears once (from the mapping), with the location the scan found.
    expect(screen.getAllByText("{{bolum:1}}")).toHaveLength(1);
    expect(screen.getByText("Sayfa 2")).toBeInTheDocument();
    expect(screen.getByText("eşlendi")).toBeInTheDocument();
    expect(screen.getByText("sona eklenecek")).toBeInTheDocument();
    // Two gaps: the unknown placeholder and the unmapped section.
    expect(screen.getByText("2 yer tutucu şablonda bulunamadı")).toBeInTheDocument();
    expect(screen.getByText("PAY-101-analiz.docx")).toBeInTheDocument();
  });

  it("offers the upload to an admin only, with a labelled file input", async () => {
    renderScreen(<DoctemplateScreen />, vi.fn(async () => json(DOC_TEMPLATE)) as unknown as typeof fetch);
    await screen.findByText("kurumsal.docx");

    expect(screen.getByRole("button", { name: "Şablon yükle (.docx)" })).toBeInTheDocument();
    const input = document.querySelector('input[type="file"]');
    expect(input).toHaveAttribute("aria-label", "Şablon yükle (.docx)");
    expect(input).toHaveAttribute("accept", ".docx");
  });

  it("tells a tech lead that uploading is an admin action", async () => {
    renderScreen(
      <DoctemplateScreen />,
      vi.fn(async () => json(NO_DOC_TEMPLATE)) as unknown as typeof fetch,
      sessionWith(["tech-lead"]),
    );
    await screen.findByText("şablon yok");

    expect(screen.queryByRole("button", { name: "Şablon yükle (.docx)" })).not.toBeInTheDocument();
    expect(document.querySelector('input[type="file"]')).toBeNull();
    expect(screen.getByText(/Şablonu yalnız admin yükleyebilir/)).toBeInTheDocument();
  });
});
