import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../src/auth/AuthProvider.tsx";
import type { Session } from "../src/auth/types.ts";
import { I18nProvider } from "../src/i18n/I18nProvider.tsx";
import { DetailScreen } from "../src/screens/Detail.tsx";
import {
  calismaAlaniDurumu,
  raporDosyaAdi,
  raporHtml,
  type RaporGirdisi,
} from "../src/screens/detail/rapor.ts";
import { ToastProvider } from "../src/ui/Toast.tsx";

/**
 * "Tanı raporu indir" — the one-click answer to "this ticket is stuck".
 *
 * Two halves, tested separately because they fail separately:
 *
 *  · `rapor.ts` is a pure function (data + translator in, HTML string out), so
 *    the report's CONTENT is asserted with no DOM and no network at all. What
 *    matters there is order and omission: the error has to be above the step
 *    history, and a section with no data must not be drawn.
 *  · `Detail.tsx` owns the browser half — Blob, object URL, `<a download>`.
 *    That is stubbed, because jsdom has no download and asserting on a real one
 *    would only prove jsdom's stub works.
 */

const TECH_LEAD: Session = {
  userId: "ayse.kaya@ugurbank.local",
  username: "ayse.kaya",
  roles: ["tech-lead"],
  groups: ["maestro-ugurpay"],
  delegated: false,
  expiresAt: "2099-01-01T00:00:00.000Z",
};

/** The catalog record as `read-models.ts:RunRecord` sends it — every field. */
function record(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ticketKey: "UGURPAY-501",
    title: "Ödeme kuyruğu takılıyor",
    appId: "odeme-servisi",
    mode: "ai_assist",
    risk: "orta",
    dataClass: "dahili",
    parentTicketKey: null,
    childTicketKeys: [],
    reporter: "mehmet.demir@ugurbank",
    assignee: null,
    prId: null,
    costUsd: 0,
    tokensIn: 0,
    tokensOut: 0,
    startedAt: "2026-08-01T09:00:00.000Z",
    updatedAt: "2026-08-01T09:00:00.000Z",
    archivedAt: null,
    ...extra,
  };
}

function state(status = "fail", step = "3o"): Record<string, unknown> {
  return {
    runId: "run-501-aaaaaaaa",
    ticketKey: "UGURPAY-501",
    step,
    status,
    risk: "orta",
    startedAt: "2026-08-01T09:00:00.000Z",
    updatedAt: "2026-08-01T11:00:00.000Z",
  };
}

const APPLICATION = {
  appId: "odeme-servisi",
  displayName: "Ödeme Servisi",
  adoProject: "UgurBank",
  adoRepo: "odeme-servisi",
  platform: "dotnet",
  jiraComponent: null,
  maestroYamlPresent: true,
  createdVia: "onboarding",
};

const FAILURE = {
  step: "3o",
  kind: "handover",
  title: "model çağrısı reddedildi",
  detail: "HTTP 403 forbidden: invalid_api_key",
  at: "2026-08-01T10:30:00.000Z",
  seq: 7,
};

/** A discovery line saying the repository was never cloned (workflows/analysis.ts). */
const KLONSUZ_SATIR = {
  runId: "run-501-aaaaaaaa",
  seq: 3,
  at: "2026-08-01T09:10:00.000Z",
  actor: "system",
  kind: "discovery",
  title: "repo keşfi yapılamadı",
  detail: "odeme-servisi için çalışma alanı yok (klon açılmamış): WORKSPACE_ROOT ayarlı mı",
};

const JOURNAL = [
  {
    runId: "run-501-aaaaaaaa",
    seq: 1,
    at: "2026-08-01T09:05:00.000Z",
    actor: "ai",
    kind: "analysis",
    title: "Analiz belgesi üretildi",
    detail: "",
  },
  KLONSUZ_SATIR,
];

/**
 * A translator with the SHAPE of the real one, not the real catalog: these
 * tests assert structure and ordering, and pinning them to Turkish wording
 * would make a copy edit break the report's tests.
 */
const t = (key: string, params: Record<string, string> = {}): string =>
  Object.keys(params).length === 0
    ? key
    : `${key}(${Object.entries(params)
        .map(([k, v]) => `${k}=${v}`)
        .join(",")})`;

function girdi(over: Partial<RaporGirdisi> = {}): RaporGirdisi {
  return {
    detail: {
      run: record(),
      state: state(),
      application: APPLICATION,
    } as unknown as RaporGirdisi["detail"],
    errors: [FAILURE] as unknown as RaporGirdisi["errors"],
    journal: JOURNAL as unknown as RaporGirdisi["journal"],
    cost: undefined,
    t,
    locale: "tr",
    now: new Date("2026-08-01T12:00:00.000Z"),
    ...over,
  };
}

describe("rapor.ts — the run's own diagnosis report", () => {
  it("puts the error ABOVE the step history and the identity block", () => {
    const html = raporHtml(girdi());

    const hata = html.indexOf("detail.rapor.section.hata");
    const defter = html.indexOf("detail.rapor.section.defter");
    const kunye = html.indexOf("detail.rapor.section.kunye");

    expect(hata).toBeGreaterThan(-1);
    // The identity block names WHICH run this is, so it stays first; but the
    // error must beat everything that answers "what happened", or the operator
    // scrolls past the answer they opened the file for.
    expect(kunye).toBeLessThan(hata);
    expect(hata).toBeLessThan(defter);

    // The error's own words are carried, in full — not summarised.
    expect(html).toContain("model çağrısı reddedildi");
    expect(html).toContain("HTTP 403 forbidden: invalid_api_key");
  });

  it("reports a run that failed with no journal error line as exactly that", () => {
    const html = raporHtml(girdi({ errors: [] }));
    expect(html).toContain("detail.rapor.section.hata");
    expect(html).toContain("detail.steps.failure_unknown");
  });

  it("says the clone was never opened when the discovery line says so", () => {
    const html = raporHtml(girdi());
    expect(calismaAlaniDurumu(JOURNAL as never)).toBe("yok");
    expect(html).toContain("detail.rapor.workspace.none");
    // …and turns that finding into the fix, not just a fact.
    expect(html).toContain("detail.rapor.oneri.workspace");
  });

  it("does not claim 'no clone' when discovery simply has not run", () => {
    const noDiscovery = [JOURNAL[0]] as unknown as RaporGirdisi["journal"];
    const html = raporHtml(girdi({ journal: noDiscovery }));
    expect(calismaAlaniDurumu(noDiscovery)).toBe("bilinmiyor");
    expect(html).toContain("detail.rapor.workspace.unknown");
    expect(html).not.toContain("detail.rapor.workspace.none");
  });

  /**
   * The rule this file exists to keep: an empty "Error: none" heading answers a
   * question nobody asked, and clears a run nothing was measured about.
   */
  it("draws no error, journal, cost or advice section when there is no data for it", () => {
    const html = raporHtml(
      girdi({
        detail: {
          run: record(),
          state: state("running", "6a"),
          application: null,
        } as unknown as RaporGirdisi["detail"],
        errors: [],
        journal: [],
        cost: undefined,
      }),
    );

    expect(html).not.toContain("detail.rapor.section.hata");
    expect(html).not.toContain("detail.rapor.section.defter");
    expect(html).not.toContain("detail.rapor.section.maliyet");
    expect(html).not.toContain("detail.rapor.section.oneri");
    // The identity block always stands: it is what makes the file this run's.
    expect(html).toContain("detail.rapor.section.kunye");
    expect(html).toContain("UGURPAY-501");
  });

  it("draws the model-call section only when the cost tab's answer is loaded", () => {
    const cost = {
      items: [
        {
          at: "2026-08-01T09:30:00.000Z",
          role: "analyst",
          model: "gpt-5",
          driver: "openai_compat",
          tokensIn: 1200,
          tokensOut: 340,
          usd: 0.42,
        },
      ],
      totals: { usd: 0.42, tokensIn: 1200, tokensOut: 340, calls: 1 },
    };
    const html = raporHtml(girdi({ cost }));
    expect(html).toContain("detail.rapor.section.maliyet");
    expect(html).toContain("gpt-5");
  });

  it("escapes text that would otherwise close a tag", () => {
    const html = raporHtml(
      girdi({
        errors: [
          { ...FAILURE, detail: "<script>alert('x')</script>" },
        ] as unknown as RaporGirdisi["errors"],
      }),
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("names the file after the ticket", () => {
    expect(raporDosyaAdi("UGURPAY-501")).toBe("maestro-UGURPAY-501-tani.html");
  });

  /** A self-contained file: the style travels with it, no external resource. */
  it("embeds its own style and opens as a whole document", () => {
    const html = raporHtml(girdi());
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<style>");
    expect(html).not.toContain("<link");
    expect(html).not.toContain("http://");
  });
});

describe("Detail screen — the download button", () => {
  const routes: Readonly<Record<string, () => Response>> = {
    "/api/studio/runs/UGURPAY-501/journal": () => json({ items: JOURNAL, nextCursor: null }),
    "/api/studio/runs/UGURPAY-501": () =>
      json({
        run: record(),
        state: state(),
        application: APPLICATION,
        recentErrors: [FAILURE],
      }),
  };

  /**
   * `defineProperty` ile konan global GERİ ALINMALI — `restoreAllMocks` onu
   * bilmez. Bırakıldığında `URL.createObjectURL` kalıcı olarak tanımlı kalıyor
   * ve DÜZ ATAMA yapan komşu testler (`screens-c.test.tsx`, CSV indirme)
   * "Cannot assign to read only property" ile düşüyordu — bu dosya geçerken
   * başka bir dosya kırılıyordu, yani hata testin kendisinde görünmüyordu.
   */
  const oncekiUrl: Record<string, PropertyDescriptor | undefined> = {};
  afterEach(() => {
    vi.restoreAllMocks();
    for (const ad of ["createObjectURL", "revokeObjectURL"]) {
      const onceki = oncekiUrl[ad];
      if (onceki === undefined) delete (URL as unknown as Record<string, unknown>)[ad];
      else Object.defineProperty(URL, ad, onceki);
      delete oncekiUrl[ad];
    }
  });

  /** Stub'ı koyarken ÖNCEKİ tanımı saklar, `afterEach` onu geri koyar. */
  function urlStubla(ad: string, deger: unknown): void {
    oncekiUrl[ad] = Object.getOwnPropertyDescriptor(URL, ad);
    Object.defineProperty(URL, ad, { value: deger, configurable: true, writable: true });
  }

  it("renders the button and hands a Blob to a download anchor on click", async () => {
    // jsdom implements neither; both are stubbed so the test asserts what the
    // screen DID rather than what a polyfill would have done with it.
    const createObjectURL = vi.fn((_blob: Blob) => "blob:tani");
    const revokeObjectURL = vi.fn();
    urlStubla("createObjectURL", createObjectURL);
    urlStubla("revokeObjectURL", revokeObjectURL);
    // The anchor is created, clicked and dropped inside the handler, so the
    // spy is the only place it can be observed — `this` at click time IS the
    // element the browser would have downloaded from.
    const clicked: HTMLAnchorElement[] = [];
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        clicked.push(this);
      });

    renderDetail();
    const button = await screen.findByRole("button", { name: "Tanı raporu indir" });

    await userEvent.click(button);

    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    const blob = createObjectURL.mock.calls[0]![0];
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toContain("text/html");
    // Downloaded, then released: an object URL held past the click leaks the
    // whole report for the life of the tab.
    expect(click).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:tani");

    const anchor = clicked[0]!;
    expect(anchor.download).toBe("maestro-UGURPAY-501-tani.html");
    expect(anchor.href).toContain("blob:tani");
  });

  it("makes no extra request for the report — it uses what the screen loaded", async () => {
    Object.defineProperty(URL, "createObjectURL", { value: vi.fn(() => "blob:tani"), configurable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), configurable: true });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);

    const { calls } = renderDetail();
    const button = await screen.findByRole("button", { name: "Tanı raporu indir" });
    const before = calls.length;

    await userEvent.click(button);
    await waitFor(() => expect(click).toHaveBeenCalled());

    expect(calls.length).toBe(before);
  });

  interface Call {
    readonly url: string;
  }

  function renderDetail(): { calls: Call[] } {
    const calls: Call[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push({ url });
      const key = Object.keys(routes)
        .filter((route) => url.startsWith(route))
        .sort((a, b) => b.length - a.length)[0];
      if (key === undefined) return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
      return routes[key]!();
    }) as typeof fetch;

    renderScreen(<DetailScreen />, { fetchImpl });
    return { calls };
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function renderScreen(ui: ReactNode, options: { fetchImpl: typeof fetch }): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <I18nProvider initialLocale="tr">
      <QueryClientProvider client={queryClient}>
        <AuthProvider fetchImpl={options.fetchImpl} initialSession={TECH_LEAD} initialToken="test-token">
          <ToastProvider>
            <MemoryRouter initialEntries={["/detail/UGURPAY-501"]}>
              <Routes>
                <Route path="/detail/:ticket" element={ui} />
              </Routes>
            </MemoryRouter>
          </ToastProvider>
        </AuthProvider>
      </QueryClientProvider>
    </I18nProvider>,
  );
}
