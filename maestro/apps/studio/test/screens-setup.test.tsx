import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { SetupScreen } from "../src/screens/Setup.tsx";
import { flowUnavailableReason } from "../src/screens/setup/model.ts";
import { ADMIN, VIEWER, renderScreen, stubFetch, type Route } from "./harness.tsx";

/**
 * The guided setup wizard (Kurulum sihirbazı).
 *
 * `/projects` can already set everything this screen sets; the wizard exists
 * because a bank operator cannot be expected to know WHICH of its three tabs
 * they need, or that the Jira status map is buried inside one of the forms. So
 * the behaviours worth testing are not "does a select render" but the promises
 * the wizard makes to that operator:
 *
 *  · the happy path actually writes the rule it summarised, with the flow they
 *    picked and — because they never opted in — no status map at all;
 *  · turning the map on sends ONLY the points they filled, never `""` for the
 *    blank ones (which the BFF answers with a 400 for the whole rule);
 *  · going back does not eat what was typed, which is the single failure that
 *    makes a wizard worse than the form it replaced;
 *  · a duplicate rule comes back as a sentence about what already exists, not
 *    as `duplicate_listening_rule`;
 *  · a missing prerequisite is NAMED, so the operator knows they need a Jira
 *    connection rather than that "something went wrong".
 */

const JIRA_CONN = {
  id: "jira-1",
  kind: "jira_cloud",
  displayName: "UgurBank Jira",
  botAccountId: "712020:bot",
};
const SCM_CONN = { id: "scm-1", kind: "github", displayName: "UgurBank GitHub" };

/** The live OPS project's real status names, as the endpoint returns them. */
const OPS_STATUSES = ["İNCELEMEDE", "Yapılacaklar", "Tamam", "Devam Ediyor"];
const OPS_ISSUE_TYPES = ["Hata", "Görev", "Alt görev"];

/**
 * The endpoints the wizard reads on mount and as the operator advances.
 *
 * `/onboarding/jira-match-values` answers by `kind`, which the stub cannot see
 * (the harness matches on pathname only), so the tests that care about the
 * distinction override this route with their own body.
 */
function baseRoutes(overrides: readonly Route[] = []): Route[] {
  const routes: Route[] = [
    { path: "/onboarding/options", body: { jiraProjects: [], adoRepos: [], platforms: ["linux-node"] } },
    { path: "/onboarding/jira-connections", body: { connections: [JIRA_CONN] } },
    { path: "/onboarding/scm-connections", body: { connections: [SCM_CONN] } },
    {
      path: "/onboarding/jira-projects",
      body: { ok: true, projects: [{ key: "OPS", name: "Operasyon" }] },
    },
    {
      path: "/onboarding/scm-repos",
      body: { ok: true, repos: [{ id: "r1", fullName: "Uguryldz/maestro-pilot" }] },
    },
    { path: "/onboarding/jira-match-values", body: { ok: true, values: OPS_ISSUE_TYPES } },
    { path: "/routing", body: { projects: [], rules: [], policy: null } },
    // Step 5's read: what is in force now, and whether this driver can poll at
    // all. A Jira Cloud connection can, so the default fixture says so.
    {
      path: "/studio/command-intake",
      body: {
        mode: "webhook",
        pollSeconds: 0,
        canReadComments: true,
        appliesLive: true,
        source: "default",
      },
    },
    { path: "/settings", method: "PUT", body: { results: [] } },
    { path: "/studio/listening-rules", method: "POST", status: 201, body: { rule: { ruleId: "lr_1" } } },
    { path: "/onboarding", method: "POST", body: { proposalId: "pr_1" } },
    // Kaydın hemen ardından sihirbaz bağlamayı kendisi onaylamayı dener; ana
    // yönetici kendi teklifini onaylayabildiği için varsayılan fixture 200.
    { path: "/onboarding/approve", method: "POST", body: { status: "bound", projectKey: "OPS", nextStep: "" } },
  ];
  // An override REPLACES the route with the same path+method rather than being
  // appended: the harness matches the first hit, so appending would be ignored.
  const result = routes.filter(
    (r) =>
      !overrides.some((o) => o.path === r.path && (o.method ?? "GET") === (r.method ?? "GET")),
  );
  return [...overrides, ...result];
}

/**
 * Adım 1 (proje): tek Jira bağlantısı KENDİLİĞİNDEN seçilir, kutuya dokunulmaz;
 * yalnız proje seçilip ilerlenir. Depo burada SORULMUYOR — akışla birlikte
 * 2. adımda.
 */
async function fillProject(): Promise<void> {
  await screen.findByText("Hangi Jira projesi, hangi uygulama?");
  await screen.findByRole("option", { name: "OPS · Operasyon" });
  await userEvent.selectOptions(screen.getByLabelText("Jira projesi"), "OPS");
  await userEvent.click(screen.getByRole("button", { name: "İleri" }));
}

/**
 * Adım 2'nin başı: akış. Varsayılan "Yalnızca analiz"; kod yazan akışı isteyen
 * testler `gelistirme` seçiyor. `duzeltme` sihirbazda SUNULMUYOR (kapı kutuları
 * aynı işi görerek yapıyor). İleri'ye BASMAZ — depo ve tetikleme aynı adımda.
 */
async function chooseFlow(flow?: "gelistirme"): Promise<void> {
  await screen.findByText("Hangi ticket'ları alsın?");
  if (flow !== undefined) {
    await userEvent.click(screen.getByRole("radio", { name: /Analiz \+ kod \+ PR/ }));
  }
}

/** Adım 2'de depo: tek SCM bağlantısı kendiliğinden seçili, liste açık gelir. */
async function pickRepo(): Promise<void> {
  await screen.findByRole("option", { name: "Uguryldz/maestro-pilot" });
  // Zorunluysa "Kod deposu", isteğe bağlıysa uzun etiket — aynı kutu.
  const repoBox =
    screen.queryByLabelText("Kod deposu") ??
    screen.getByLabelText("Kod deposu (analiz kodu okusun diye, isteğe bağlı)");
  await userEvent.selectOptions(repoBox, "Uguryldz/maestro-pilot");
  /*
   * Platform kutusu YALNIZ birden fazla profil varsa çizilir. Tek profilli bir
   * kurulumda soracak bir şey yok: taslak kendi doluyor ve ekran hangisi
   * olduğunu satır altında yazıyor. Fixture tek profil taşıdığı için kutu
   * burada yok — `queryByLabelText` ile varsa seçiyoruz, yoksa geçiyoruz.
   */
  const platformBox = screen.queryByLabelText("Uygulamanın teknolojisi");
  if (platformBox !== null) await userEvent.selectOptions(platformBox, "linux-node");
}

/**
 * Fill the rest of step 2 (the trigger value) and move on.
 *
 * `value` is the LOCALISED name Jira serves and the rule stores; `label` is
 * what the operator reads, which now carries the English name beside it. The
 * two are looked up separately on purpose — selecting by value while finding by
 * label is the round trip that proves the dropdown shows one string and sends
 * another.
 */
async function fillTickets(value = "Hata", label = "Hata (Bug)"): Promise<void> {
  await screen.findByText("Hangi ticket'ları alsın?");
  // The value list is read live off the project, so it is a dropdown.
  await screen.findByRole("option", { name: label });
  await userEvent.selectOptions(screen.getByLabelText("Hangi değer?"), value);
  await userEvent.click(screen.getByRole("button", { name: "İleri" }));
}

/**
 * Walk step 4 (Jira ile iletişim — how commands arrive) by ACCEPTING what the
 * platform already does, and move on to the summary.
 *
 * Accepting rather than answering is the point for every test that is not
 * about this step: an unchanged answer must not write a parameter version, so
 * these walks also assert — by way of `settingsCalls` staying empty in the
 * happy-path test — that the wizard does not churn a global setting on a run
 * that never touched it.
 */
async function skipIntake(): Promise<void> {
  await screen.findByText("Onaylar Maestro'ya nasıl ulaşsın?");
  await userEvent.click(screen.getByRole("button", { name: "İleri" }));
}

/** The body of the POST that created the listening rule. */
function ruleBody(calls: readonly { url: string; method: string; body: unknown }[]): Record<string, unknown> {
  const call = calls.find(
    (c) => c.url.includes("/studio/listening-rules") && c.method === "POST",
  );
  expect(call, "the wizard never POSTed a listening rule").toBeTruthy();
  return call!.body as Record<string, unknown>;
}

describe("setup wizard", () => {
  it("opens on the project question, with the sole Jira connection already picked", async () => {
    const { fetchImpl } = stubFetch(baseRoutes());
    renderScreen(<SetupScreen />, { fetchImpl });

    await screen.findByText("Hangi Jira projesi, hangi uygulama?");
    // Ölçülen şikâyet: tek Jira'lı kurulumda kutu "Seçiniz" bekliyor ve ipucu
    // "tek seçenek gelir" diyordu. Tek seçenekli soru sorulmaz — seçilir.
    await waitFor(() =>
      expect((screen.getByLabelText("Jira bağlantısı") as HTMLSelectElement).value).toBe("jira-1"),
    );
    // Beş adım, tek liste: sihirbazın kendi şeridi. "Ne yapsın" ayrı adım değil.
    expect(screen.getByRole("button", { name: "1 · Proje & uygulama" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "2 · Hangi ticket'lar" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "3 · Jira durumları" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "4 · Jira ile iletişim" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "5 · Özet & kaydet" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Ne yapsın/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /6 ·/ })).toBeNull();
    // Depo bu adımda SORULMUYOR — "depo bağlama" diye katlanır bir grup yok.
    expect(screen.queryByText(/Depo bağlama/)).toBeNull();
    expect(screen.queryByLabelText(/Kod deposu/)).toBeNull();
  });

  it("asks the flow on the tickets step, described by outcome rather than by jargon", async () => {
    const { fetchImpl } = stubFetch(baseRoutes());
    renderScreen(<SetupScreen />, { fetchImpl });

    await fillProject();
    await screen.findByText("Hangi ticket'ları alsın?");
    expect(screen.getByText("Ne yapılsın")).toBeTruthy();
    // The two flows, each with the sentence that says what it DOES. Nothing
    // on this screen says "risk_tiered" or "opt_in" — that is the whole point.
    expect(
      screen.getByText(/analiz belgesini ticket'a yazsın; kod YAZMASIN/),
    ).toBeTruthy();
    expect(screen.getByRole("radio", { name: /Analiz \+ kod \+ PR/ })).toBeTruthy();
    // `duzeltme` kartı YOK: motorda tek yaptığı kapı 4/5'i kapatmaktı ve
    // operatör aynı sonucu dinleme kuralındaki kutulardan, görerek alıyor.
    expect(screen.queryByRole("radio", { name: /Hata düzeltme/ })).toBeNull();
    // Analysis leads: a first-time operator clicking straight through must end
    // up with the flow that cannot touch a repository.
    expect((screen.getByRole("radio", { name: /Yalnızca analiz/ }) as HTMLInputElement).checked).toBe(
      true,
    );
  });

  it("numbers every step's subtitle the way the strip does", async () => {
    const { fetchImpl } = stubFetch(baseRoutes());
    renderScreen(<SetupScreen />, { fetchImpl });

    // Ölçülen tutarsızlık: Özet adımı "5. adım" derken solda "6" yazıyordu.
    await fillProject();
    expect(screen.getByText(/^2\. adım/)).toBeTruthy();
    await chooseFlow();
    await fillTickets();
    expect(await screen.findByText(/^3\. adım/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "İleri" }));
    expect(await screen.findByText(/^4\. adım/)).toBeTruthy();
    await skipIntake();
    await screen.findByText("Özet");
    expect(screen.getByText(/^5\. adım/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "5 · Özet & kaydet" }).getAttribute("aria-current")).toBe("step");
  });

  it("creates the rule with the chosen flow and no status map on the happy path", async () => {
    const { fetchImpl, calls } = stubFetch(baseRoutes());
    renderScreen(<SetupScreen />, { fetchImpl });

    await fillProject();
    await chooseFlow("gelistirme");
    await pickRepo();
    await fillTickets();

    // Step 4 is skipped without touching it — the wizard says so on the button.
    await screen.findByText("Jira durumlarını da değiştirsin mi?");
    expect(screen.getByText("Bu adım isteğe bağlı; dokunmadan geçebilirsiniz.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "İleri" }));

    // Step 5 — how approvals arrive — accepted as-is; nothing changes, so no
    // parameter is written (asserted below).
    await skipIntake();

    // Step 6 spells the configuration back as sentences, not as a field dump.
    await screen.findByText("Özet");
    expect(
      screen.getByText(
        /OPS projesinde, bota atanmış ve İş tipi değeri "Hata \(Bug\)" olan ticket'lar .* akışıyla çalışacak\./,
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Maestro ticket'a yalnızca yorum yazacak; panodaki durumunu hiç değiştirmeyecek.",
      ),
    ).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Kurulumu tamamla" }));

    await waitFor(() => {
      const body = ruleBody(calls);
      expect(body.projectKey).toBe("OPS");
      expect(body.matchKind).toBe("issuetype");
      expect(body.matchValue).toBe("Hata");
      expect(body.flowType).toBe("gelistirme");
      // The bot account pre-filled itself from the tested connection — the
      // operator never hand-copied a 40-char GUID.
      expect(body.assigneeAccountId).toBe("712020:bot");
      // Comment-only is the default, and `null` is the ONE shape that says so.
      expect(body.statusMap).toBeNull();
    });
  });

  it("files the binding proposal with the defaults the chosen flow implies", async () => {
    const { fetchImpl, calls } = stubFetch(baseRoutes());
    renderScreen(<SetupScreen />, { fetchImpl });

    await fillProject();
    await chooseFlow("gelistirme");
    await pickRepo();
    await fillTickets();
    await userEvent.click(await screen.findByRole("button", { name: "İleri" }));
    await skipIntake();
    await screen.findByText("Özet");
    await userEvent.click(screen.getByRole("button", { name: "Kurulumu tamamla" }));

    await waitFor(() => {
      const call = calls.find((c) => c.url.endsWith("/onboarding") && c.method === "POST");
      expect(call, "no binding proposal was filed").toBeTruthy();
      // The operator answered ONE question ("yeni özellik geliştirme"); the
      // three the expert screen would have asked fall out of it.
      expect(call!.body).toEqual({
        jiraProject: "OPS",
        adoRepo: "Uguryldz/maestro-pilot",
        platform: "linux-node",
        /*
         * `false` — ENVANTER yazılsın, BAĞLAMA VARSAYILANI yazılmasın.
         *
         * İkisi bir dönem tek karardı. `Application` satırı her zaman gerekli:
         * kuralın eşlemesi bir depo adı gösteriyorsa o adın envanterde satırı
         * olmak zorunda, yoksa koşu satırı yabancı anahtar hatasıyla patlıyor
         * (OPS-121). `defaults.appId` ise zincirin son halkasıydı ve sessiz bir
         * varsayılandı — eşleme cevap veremediğinde devreye girip operatöre
         * eşlemenin çalıştığını sandırıyordu. Zincirden çıkarıldı.
         */
        bindDefaultApp: false,
        triggerMode: "opt_in",
        gateSet: "always_six",
        mergeMode: "human",
        // The data class the operator was ASKED for, defaulted to the
        // safe-but-workable class rather than left to the server's fail-closed
        // `gizli` — the assumption that silently disabled SAM1's analysis.
        dataClass: "dahili",
      });
    });
  });

  /**
   * KAYDET SONRASI ONAY ÇIKMAZI — kapatıldı.
   *
   * Sihirbaz teklifi yazıp "ikinci yönetici onaylasın" diye bırakıyordu; tek
   * yöneticili kurulumda operatör Proje bağlama ekranına gidip KENDİ teklifini
   * onaylamak zorundaydı. BFF ana onaylayıcıya kendi teklifini onaylama izni
   * veriyor (`masterSolo`), vermiyorsa `409 self_approval` dönüyor. Sihirbaz
   * artık kaydın hemen ardından onayı dener ve üç sonucu üç ayrı cümleyle
   * söyler.
   */
  it("approves the binding on the spot and says the project is live (200)", async () => {
    const { fetchImpl, calls } = stubFetch(baseRoutes());
    renderScreen(<SetupScreen />, { fetchImpl });

    await fillProject();
    await chooseFlow();
    await pickRepo();
    await fillTickets();
    await userEvent.click(await screen.findByRole("button", { name: "İleri" }));

    // Stated BEFORE the button: the wizard will TRY the approval itself.
    await skipIntake();
    await screen.findByText("Özet");
    expect(screen.getByText(/sizin adınıza hemen onaylamayı dener/)).toBeTruthy();
    expect(screen.queryByText(/ikinci bir yöneticinin onayını bekler/)).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Kurulumu tamamla" }));

    expect(await screen.findByText("Kurulum tamam")).toBeTruthy();
    expect(screen.getByText(/Proje bağlandı ve devrede/)).toBeTruthy();
    // No approval note, no queue link: nothing is waiting anywhere.
    expect(screen.queryByText(/ikinci bir yöneticinin onayını bekliyor/)).toBeNull();
    expect(screen.queryByRole("link", { name: "Onay kuyruğunu aç" })).toBeNull();
    // Onay KURALDAN SONRA: onay varsayılan kuralları tohumluyor ve kuraldan
    // önce gelseydi sihirbazın kuralı çoğaltma diye düşebilirdi.
    const rule = calls.findIndex((c) => c.url.endsWith("/studio/listening-rules") && c.method === "POST");
    const approve = calls.findIndex((c) => c.url.endsWith("/onboarding/approve") && c.method === "POST");
    expect(approve).toBeGreaterThan(rule);
    expect(calls[approve]!.body).toEqual({ projectKey: "OPS" });
    // The concrete next actions, with the Panel — a screen the menu HAS.
    expect(
      screen.getByText(
        "OPS projesinde İş tipi değeri \"Hata (Bug)\" olan bir ticket açın (ya da mevcut birini o değere getirin).",
      ),
    ).toBeTruthy();
    expect(screen.getByText(/Ticket'ı Maestro botuna atayın/)).toBeTruthy();
    expect(screen.getByText(/İşin başladığını Panel'den izleyin/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Panel'i aç" }).getAttribute("href")).toBe("/dash");
    expect(screen.queryByText(/Canlı akış/)).toBeNull();
  });

  it("falls back to the four-eyes note with a queue link when the BFF answers self_approval (409)", async () => {
    const { fetchImpl } = stubFetch(
      baseRoutes([
        { path: "/onboarding/approve", method: "POST", status: 409, body: { error: "self_approval" } },
      ]),
    );
    renderScreen(<SetupScreen />, { fetchImpl });

    await fillProject();
    await chooseFlow();
    await pickRepo();
    await fillTickets();
    await userEvent.click(await screen.findByRole("button", { name: "İleri" }));
    await skipIntake();
    await screen.findByText("Özet");
    await userEvent.click(screen.getByRole("button", { name: "Kurulumu tamamla" }));

    // Not a failure: the rule is saved, the binding waits for a second admin.
    expect(await screen.findByText("Kurulum tamam")).toBeTruthy();
    expect(screen.getByText(/ikinci bir yöneticinin onayını bekliyor/)).toBeTruthy();
    expect(screen.queryByText(/Proje bağlandı ve devrede/)).toBeNull();
    const links = screen.getAllByRole("link", { name: "Onay kuyruğunu aç" });
    expect(links.length).toBeGreaterThan(0);
    expect(links[0]!.getAttribute("href")).toBe("/projects?tab=routing");
  });

  it("names any other approval failure and still links the queue", async () => {
    const { fetchImpl } = stubFetch(
      baseRoutes([
        { path: "/onboarding/approve", method: "POST", status: 404, body: { error: "no_pending_binding" } },
      ]),
    );
    renderScreen(<SetupScreen />, { fetchImpl });

    await fillProject();
    await chooseFlow();
    await pickRepo();
    await fillTickets();
    await userEvent.click(await screen.findByRole("button", { name: "İleri" }));
    await skipIntake();
    await screen.findByText("Özet");
    await userEvent.click(screen.getByRole("button", { name: "Kurulumu tamamla" }));

    expect(await screen.findByText("Kurulum tamam")).toBeTruthy();
    // The catalog sentence for the code, inside the wizard's own sentence.
    expect(screen.getByText(/kaydedildi ama onaylanamadı/)).toBeTruthy();
    expect(screen.getByText(/onay bekleyen bir paket yok/i)).toBeTruthy();
    expect(screen.queryByText(/no_pending_binding/)).toBeNull();
    expect(screen.getAllByRole("link", { name: "Onay kuyruğunu aç" })[0]!.getAttribute("href")).toBe(
      "/projects?tab=routing",
    );
  });

  it("skips the binding proposal when the project is already bound, and says so", async () => {
    const { fetchImpl, calls } = stubFetch(
      baseRoutes([
        {
          path: "/routing",
          body: {
            projects: [{ projectKey: "OPS", trigger: "label", apps: [], noteKey: "" }],
            rules: [],
            policy: null,
          },
        },
        // Bağlı projede teklif yok ama depo yine envantere girer: kuralın
        // eşlemesi bu adı gösteriyor ve sunucu satırı zorunlu tutuyor.
        { path: "/onboarding/apps", method: "POST", body: { ok: true } },
      ]),
    );
    renderScreen(<SetupScreen />, { fetchImpl });

    await fillProject();
    await chooseFlow();
    await pickRepo();
    await fillTickets();
    await userEvent.click(await screen.findByRole("button", { name: "İleri" }));
    await skipIntake();
    await screen.findByText("Özet");

    // Promising a four-eyes approval for a live binding sends the operator
    // looking for an approval queue that has nothing in it.
    expect(
      screen.getByText(/OPS projesi zaten bağlı; yeni bir bağlama önerisi oluşturulmayacak/),
    ).toBeTruthy();
    expect(screen.queryByText(/sizin adınıza hemen onaylamayı dener/)).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Kurulumu tamamla" }));
    await screen.findByText("Kurulum tamam");
    expect(calls.find((c) => c.url.endsWith("/onboarding") && c.method === "POST")).toBeUndefined();
    // Nothing to approve either — and nothing claimed about it on the done screen.
    expect(calls.find((c) => c.url.endsWith("/onboarding/approve"))).toBeUndefined();
    expect(screen.queryByText(/Proje bağlandı ve devrede/)).toBeNull();
    expect(screen.queryByText(/ikinci bir yöneticinin onayını bekliyor/)).toBeNull();
  });

  describe("the optional status map", () => {
    /** Step 4 with the live status list, which needs kind=status to answer. */
    function statusRoutes(): Route[] {
      return baseRoutes([
        // Both kinds come off one path, and the harness cannot see `kind`. The
        // free-text fallback is what these tests exercise, so answer `ok:false`
        // and let both fields fall back — the behaviour when Jira is unreadable
        // is the one an operator is most likely to meet on a fresh install.
        { path: "/onboarding/jira-match-values", body: { ok: false, messageKey: "error.unexpected" } },
      ]);
    }

    async function reachStatusStep(flow?: "gelistirme"): Promise<void> {
      await fillProject();
      await chooseFlow(flow);
      await pickRepo();
      // With no live list the value is a free-text field.
      await screen.findByText("Hangi ticket'ları alsın?");
      await userEvent.type(screen.getByLabelText("Hangi değer?"), "Hata");
      await userEvent.click(screen.getByRole("button", { name: "İleri" }));
      await screen.findByText("Jira durumlarını da değiştirsin mi?");
    }

    it("keeps the five points hidden until the operator turns the map on", async () => {
      const { fetchImpl } = stubFetch(statusRoutes());
      renderScreen(<SetupScreen />, { fetchImpl });
      await reachStatusStep();

      // Reading the step must not be the same act as opting into it.
      expect(screen.queryByLabelText("İş başladığında")).toBeNull();
      await userEvent.click(screen.getByLabelText("Ticket'ın Jira durumunu da değiştirsin"));
      expect(await screen.findByLabelText("İş başladığında")).toBeTruthy();
      expect(screen.getByLabelText("İş bittiğinde")).toBeTruthy();
    });

    it("sends only the points that were filled in, never \"\" for the blank ones", async () => {
      const { fetchImpl, calls } = stubFetch(statusRoutes());
      renderScreen(<SetupScreen />, { fetchImpl });
      await reachStatusStep();

      await userEvent.click(screen.getByLabelText("Ticket'ın Jira durumunu da değiştirsin"));
      await userEvent.type(await screen.findByLabelText("İş başladığında"), "Devam Ediyor");
      await userEvent.type(screen.getByLabelText("İş bittiğinde"), "Tamam");
      await userEvent.click(screen.getByRole("button", { name: "İleri" }));

      // The summary lists exactly the two points, in flow order.
      await skipIntake();
      await screen.findByText("Özet");
      const list = screen.getByText("Ticket panoda ne olacak").nextElementSibling as HTMLElement;
      expect(within(list).getByText("Devam Ediyor")).toBeTruthy();
      expect(within(list).getByText("Tamam")).toBeTruthy();

      await userEvent.click(screen.getByRole("button", { name: "Kurulumu tamamla" }));
      await waitFor(() => {
        // Two of five. The other three are ABSENT, not "": an empty string is a
        // 400 from StatusMapSchema for the whole rule, not "leave the ticket
        // alone at this step".
        expect(ruleBody(calls).statusMap).toEqual({ onStart: "Devam Ediyor", onDone: "Tamam" });
      });
    });

    it("folds an opted-in but empty map back to comment-only", async () => {
      const { fetchImpl, calls } = stubFetch(statusRoutes());
      renderScreen(<SetupScreen />, { fetchImpl });
      await reachStatusStep();

      // Ticking the box and filling nothing is not a configuration; it must not
      // become a `{}` that reads as "this rule moves tickets".
      await userEvent.click(screen.getByLabelText("Ticket'ın Jira durumunu da değiştirsin"));
      await screen.findByLabelText("İş başladığında");
      await userEvent.click(screen.getByRole("button", { name: "İleri" }));

      await skipIntake();
      await screen.findByText("Özet");
      expect(
        screen.getByText(
          "Maestro ticket'a yalnızca yorum yazacak; panodaki durumunu hiç değiştirmeyecek.",
        ),
      ).toBeTruthy();
      await userEvent.click(screen.getByRole("button", { name: "Kurulumu tamamla" }));
      await waitFor(() => expect(ruleBody(calls).statusMap).toBeNull());
    });

    it("sends reassignOnNeedInfo on its own, with no status name at all", async () => {
      const { fetchImpl, calls } = stubFetch(statusRoutes());
      renderScreen(<SetupScreen />, { fetchImpl });
      await reachStatusStep();

      await userEvent.click(screen.getByLabelText("Ticket'ın Jira durumunu da değiştirsin"));
      await userEvent.click(
        await screen.findByLabelText("Bilgi eksikken ticket'ı rapor edene geri ata"),
      );
      await userEvent.click(screen.getByRole("button", { name: "İleri" }));
      await skipIntake();
      await screen.findByText("Özet");
      await userEvent.click(screen.getByRole("button", { name: "Kurulumu tamamla" }));

      // Handing the ticket back without moving it on the board IS a real
      // configuration, so it must not collapse to "no map".
      await waitFor(() =>
        expect(ruleBody(calls).statusMap).toEqual({ reassignOnNeedInfo: true }),
      );
    });

    it("offers the project's real statuses when Jira can be read", async () => {
      const { fetchImpl } = stubFetch(
        baseRoutes([
          { path: "/onboarding/jira-match-values", body: { ok: true, values: OPS_STATUSES } },
        ]),
      );
      renderScreen(<SetupScreen />, { fetchImpl });

      await fillProject();
      await chooseFlow();
      await pickRepo();
      // With a live list every value is picked, never spelled.
      await fillTickets("İNCELEMEDE", "İNCELEMEDE (In Review)");
      await screen.findByText("Jira durumlarını da değiştirsin mi?");
      await userEvent.click(screen.getByLabelText("Ticket'ın Jira durumunu da değiştirsin"));

      const onStart = (await screen.findByLabelText("İş başladığında")) as HTMLSelectElement;
      expect([...onStart.options].map((o) => o.value)).toEqual(["", ...OPS_STATUSES]);
    });

    /**
     * `duzeltme` SİHİRBAZDA SUNULMUYOR (bkz. `OFFERED_FLOW_TYPES`): motorda
     * tek yaptığı kapı 4/5'i kapatmaktı ve operatör aynı sonucu dinleme
     * kuralındaki kapı kutularından, hangisinin kapandığını GÖREREK alıyor.
     *
     * O akışın "ölü statü noktası" davranışı KALDIRILMADI — kayıtlı düzeltme
     * kuralları hâlâ öyle çalışıyor ve dinleme formu bunu dürüstçe gösteriyor
     * (`screens-listening.test.tsx`, "the moments a düzeltme flow can never
     * reach"). Buradaki testler sihirbazın artık ulaşılamayan bir yolunu
     * sürdüğü için kaldırıldı; yerini kartın sunulmadığının kanıtı aldı.
     */
    it("düzeltme akışını KART OLARAK sunmaz — kapı kutuları aynı işi görerek yapıyor", async () => {
      const { fetchImpl } = stubFetch(statusRoutes());
      renderScreen(<SetupScreen />, { fetchImpl });
      await fillProject();
      await screen.findByText("Hangi ticket'ları alsın?");

      const flows = within(screen.getByRole("radiogroup", { name: "Ne yapılsın" }));
      expect(flows.queryByRole("radio", { name: /Hata düzeltme/ })).toBeNull();
      expect(flows.getByRole("radio", { name: /Yalnızca analiz/ })).toBeTruthy();
      expect(flows.getByRole("radio", { name: /Analiz \+ kod \+ PR/ })).toBeTruthy();
      expect(flows.getAllByRole("radio").length).toBe(2);
    });

    it("kapalıyken yalnız kutu ve tek cümle — açıklama paragrafları anahtarın arkasında", async () => {
      const { fetchImpl } = stubFetch(statusRoutes());
      renderScreen(<SetupScreen />, { fetchImpl });
      await reachStatusStep();

      // Ölçülen şikâyet: adımı atlayacak operatör üç paragraf okuyordu.
      expect(screen.queryByText(/Yukarıdaki beş satır/)).toBeNull();
      expect(screen.queryByText(/Varsayılan olarak Maestro ticket'a yalnızca yorum yazar/)).toBeNull();
      expect(screen.queryByText(/Her satır ayrı ayrı isteğe bağlıdır/)).toBeNull();
      expect(screen.getByText(/Statü eşlemesi kapalı/)).toBeTruthy();

      await userEvent.click(screen.getByLabelText("Ticket'ın Jira durumunu da değiştirsin"));
      expect(await screen.findByText(/Yukarıdaki beş satır/)).toBeTruthy();
      expect(screen.getByText(/Her satır ayrı ayrı isteğe bağlıdır/)).toBeTruthy();
    });
  });

  describe("navigation", () => {
    it("preserves every answer when the operator walks back through the steps", async () => {
      const { fetchImpl } = stubFetch(
        baseRoutes([
          { path: "/onboarding/jira-match-values", body: { ok: false, messageKey: "error.unexpected" } },
        ]),
      );
      renderScreen(<SetupScreen />, { fetchImpl });

      await fillProject();
      await chooseFlow("gelistirme");
      await pickRepo();
      await screen.findByText("Hangi ticket'ları alsın?");
      await userEvent.type(screen.getByLabelText("Hangi değer?"), "Özellik");
      await userEvent.click(screen.getByRole("button", { name: "İleri" }));

      // Turn the map on and type into it, so there is state on FOUR steps.
      await screen.findByText("Jira durumlarını da değiştirsin mi?");
      await userEvent.click(screen.getByLabelText("Ticket'ın Jira durumunu da değiştirsin"));
      await userEvent.type(await screen.findByLabelText("İş başladığında"), "Devam Ediyor");

      // All the way back to step 1 …
      const back = screen.getByRole("button", { name: "Geri" });
      await userEvent.click(back);
      await userEvent.click(screen.getByRole("button", { name: "Geri" }));
      await screen.findByText("Hangi Jira projesi, hangi uygulama?");
      expect((screen.getByLabelText("Jira projesi") as HTMLSelectElement).value).toBe("OPS");

      // … and forward again. Nothing was dropped by the round trip: "geri
      // gidince yazdıklarım gitti" is what makes a wizard worse than a form.
      await userEvent.click(screen.getByRole("button", { name: "İleri" }));
      await screen.findByText("Hangi ticket'ları alsın?");
      expect(
        (screen.getByRole("radio", { name: /Analiz \+ kod \+ PR/ }) as HTMLInputElement).checked,
      ).toBe(true);
      expect((screen.getByLabelText("Kod deposu") as HTMLSelectElement).value).toBe(
        "Uguryldz/maestro-pilot",
      );
      // Tek profilli kurulumda platform bir KUTU değil: soracak bir şey yok,
      // taslak kendi doluyor ve ekran hangisi olduğunu yazıyor. Korunan cevap
      // yine korunuyor — yalnız gösterimi değişti.
      expect(screen.getByText(/Platform: .*Node/u)).toBeTruthy();
      expect((screen.getByLabelText("Hangi değer?") as HTMLInputElement).value).toBe("Özellik");

      await userEvent.click(screen.getByRole("button", { name: "İleri" }));
      await screen.findByText("Jira durumlarını da değiştirsin mi?");
      expect(
        (screen.getByLabelText("Ticket'ın Jira durumunu da değiştirsin") as HTMLInputElement)
          .checked,
      ).toBe(true);
      expect((screen.getByLabelText("İş başladığında") as HTMLInputElement).value).toBe(
        "Devam Ediyor",
      );
    });

    it("says WHICH answer is missing instead of just disabling the button", async () => {
      // İki Jira: tek bağlantı kendiliğinden seçildiği için soru ancak gerçek
      // bir seçim varken sorulur.
      const { fetchImpl } = stubFetch(
        baseRoutes([
          {
            path: "/onboarding/jira-connections",
            body: { connections: [JIRA_CONN, { ...JIRA_CONN, id: "jira-2", displayName: "İkinci Jira" }] },
          },
        ]),
      );
      renderScreen(<SetupScreen />, { fetchImpl });

      await screen.findByText("Hangi Jira projesi, hangi uygulama?");

      // Nothing picked yet: the first thing that is missing, named.
      expect(
        await screen.findByText("Devam etmek için bir Jira bağlantısı seçin."),
      ).toBeTruthy();
      expect((screen.getByRole("button", { name: "İleri" }) as HTMLButtonElement).disabled).toBe(
        true,
      );

      // Answering it moves the complaint to the NEXT missing answer rather than
      // leaving a stale one on screen.
      await userEvent.selectOptions(screen.getByLabelText("Jira bağlantısı"), "jira-1");
      expect(
        await screen.findByText(
          "Devam etmek için Maestro'nun çalışacağı Jira projesini seçin.",
        ),
      ).toBeTruthy();
    });
  });

  describe("things the operator cannot fix from here", () => {
    it("names the missing Jira connection and links to where it is added", async () => {
      const { fetchImpl } = stubFetch(
        baseRoutes([{ path: "/onboarding/jira-connections", body: { connections: [] } }]),
      );
      renderScreen(<SetupScreen />, { fetchImpl });

      // The NOUN is in the sentence — "bir şeyler eksik" is what generates a
      // support ticket instead of resolving one.
      expect(await screen.findByText(/Hiç Jira bağlantısı tanımlı değil/)).toBeTruthy();
      const link = screen.getByRole("link", { name: "Ayarlar & bağlantılar'a git" });
      expect(link.getAttribute("href")).toBe("/settings");
    });

    it("names the missing repository connection once a code-writing flow is picked", async () => {
      const { fetchImpl } = stubFetch(
        baseRoutes([{ path: "/onboarding/scm-connections", body: { connections: [] } }]),
      );
      renderScreen(<SetupScreen />, { fetchImpl });

      // On the default flow (analiz) the card must NOT appear: the repository
      // is an offer there, and "kurulum yapılamaz" would be a false sentence
      // for the analysis-only team this install may well be.
      await fillProject();
      await screen.findByText("Hangi ticket'ları alsın?");
      expect(screen.queryByText(/Hiç kod deposu bağlantısı tanımlı değil/)).toBeNull();

      // Pick a flow that genuinely needs the repository, and the prerequisite
      // is named — noun, fix, and where.
      await userEvent.click(screen.getByRole("radio", { name: /Analiz \+ kod \+ PR/ }));
      expect(await screen.findByText(/Hiç kod deposu bağlantısı tanımlı değil/)).toBeTruthy();
    });

    /**
     * The wizard must not offer a flow this install cannot serve.
     *
     * This is the failure the whole change is about, seen from the operator's
     * side: pick "Yeni özellik geliştirme", save the rule, and the run walks
     * intake → analysis → publication → a human's approval before dying at the
     * step that needed a repository. Every one of those steps was real work,
     * and the missing piece was knowable before the first click.
     */
    it("stops a code-writing flow while no repository connection exists, and says why", async () => {
      const { fetchImpl } = stubFetch(
        baseRoutes([{ path: "/onboarding/scm-connections", body: { connections: [] } }]),
      );
      renderScreen(<SetupScreen />, { fetchImpl });

      await fillProject();
      await userEvent.click(await screen.findByRole("radio", { name: /Analiz \+ kod \+ PR/ }));

      // The NOUN and the fix, not "bir şeyler eksik". It appears on the ONE
      // code-writing choice and again beside the dead "İleri" — an operator
      // reading either place learns the same thing, so this asserts the count
      // rather than pretending there is one. (İki idi: `duzeltme` kartı
      // sunulmadığı için artık bir kod akışı var.)
      const said = await screen.findAllByText(
        /bir kod deposu bağlantısı gerekir ve bu kurulumda henüz tanımlı değil/,
      );
      expect(said.length).toBe(2);
      // And "İleri" does not walk them three steps toward a run that cannot finish.
      expect((screen.getByRole("button", { name: "İleri" }) as HTMLButtonElement).disabled).toBe(true);
    });

    it("still lets analysis through on that same install", async () => {
      // The prerequisite is per-FLOW, not a wall across the wizard: an install
      // with no repository can still be set up to produce analysis documents,
      // which is the one thing it genuinely can do.
      const { fetchImpl } = stubFetch(
        baseRoutes([{ path: "/onboarding/scm-connections", body: { connections: [] } }]),
      );
      renderScreen(<SetupScreen />, { fetchImpl });

      await fillProject();
      await screen.findByText("Hangi ticket'ları alsın?");
      // `^`: the blocked code card's note ends with “Yalnızca analiz” and would
      // otherwise match too.
      expect((screen.getByRole("radio", { name: /^Yalnızca analiz/ }) as HTMLInputElement).checked).toBe(
        true,
      );
      // The reason is on the code card ONLY — not beside "İleri", which the
      // analysis flow does not block.
      expect(screen.getAllByText(/bir kod deposu bağlantısı gerekir/).length).toBe(1);
      // What still blocks "İleri" is the trigger value, not the repository.
      expect(screen.getByText("Devam etmek için Maestro'yu hangi değerin tetikleyeceğini belirtin.")).toBeTruthy();
      await screen.findByRole("option", { name: "Hata (Bug)" });
      await userEvent.selectOptions(screen.getByLabelText("Hangi değer?"), "Hata");
      expect((screen.getByRole("button", { name: "İleri" }) as HTMLButtonElement).disabled).toBe(false);
    });

    it("offers every flow once a repository connection exists", async () => {
      // The default fixtures HAVE an SCM connection, so nothing is blocked —
      // the guard must not fire on a properly configured install.
      const { fetchImpl } = stubFetch(baseRoutes());
      renderScreen(<SetupScreen />, { fetchImpl });

      await fillProject();
      await userEvent.click(await screen.findByRole("radio", { name: /Analiz \+ kod \+ PR/ }));
      expect(screen.queryByText(/bir kod deposu bağlantısı gerekir/)).toBeNull();
      // The repository is now REQUIRED — and that, not the connection, is
      // what the dead button explains.
      expect(screen.getByText("Devam etmek için kodun yazılacağı depoyu seçin.")).toBeTruthy();
      await pickRepo();
      await screen.findByRole("option", { name: "Hata (Bug)" });
      await userEvent.selectOptions(screen.getByLabelText("Hangi değer?"), "Hata");
      expect((screen.getByRole("button", { name: "İleri" }) as HTMLButtonElement).disabled).toBe(false);
    });

    it("does not call a flow unavailable while the connection list is still in flight", () => {
      // Same rule the prerequisite banner already follows: an unanswered
      // request is not evidence of an empty list, and telling an operator to
      // go and add a connection they already have is its own bug. `null` is
      // the in-flight count, and it must answer "nothing wrong" — the one
      // predicate every flow card reads.
      expect(flowUnavailableReason("gelistirme", null)).toBeNull();
      expect(flowUnavailableReason("gelistirme", 0)).toBe("setup.flow.needs_scm");
      expect(flowUnavailableReason("analiz", 0)).toBeNull();
    });

    it("does not accuse an empty list while the request is still in flight", async () => {
      // A never-resolving connections call: the warning must not appear on the
      // strength of "the array is empty so far".
      const { fetchImpl } = stubFetch(baseRoutes());
      renderScreen(<SetupScreen />, { fetchImpl });
      await screen.findByText("Hangi Jira projesi, hangi uygulama?");
      expect(screen.queryByText(/Hiç Jira bağlantısı tanımlı değil/)).toBeNull();
      expect(screen.queryByText(/Hiç kod deposu bağlantısı tanımlı değil/)).toBeNull();
    });

    it("tells a non-admin they may look but not save", async () => {
      const { fetchImpl } = stubFetch(baseRoutes());
      renderScreen(<SetupScreen />, { fetchImpl, session: VIEWER });

      expect(await screen.findByText(/Kurulum yapmak için yönetici yetkisi gerekir/)).toBeTruthy();
    });
  });

  it("explains a duplicate rule instead of printing the error code", async () => {
    const { fetchImpl } = stubFetch(
      baseRoutes([
        {
          path: "/studio/listening-rules",
          method: "POST",
          status: 400,
          body: { error: "duplicate_listening_rule" },
        },
      ]),
    );
    renderScreen(<SetupScreen />, { fetchImpl, session: ADMIN });

    await fillProject();
    await chooseFlow();
    await pickRepo();
    await fillTickets();
    await userEvent.click(await screen.findByRole("button", { name: "İleri" }));
    await skipIntake();
    await screen.findByText("Özet");
    await userEvent.click(screen.getByRole("button", { name: "Kurulumu tamamla" }));

    // A sentence about what already exists and what to do about it — not the
    // raw code, and not the generic "beklenmeyen bir hata".
    expect(
      await screen.findByText(/Bu ticket'lar için zaten bir dinleme kuralı var/),
    ).toBeTruthy();
    expect(screen.queryByText(/duplicate_listening_rule/)).toBeNull();
    expect(screen.queryByText(/Beklenmeyen/)).toBeNull();
    // The operator is left ON the summary step, able to change the value —
    // not thrown back to the start of the wizard.
    expect(screen.getByText("Özet")).toBeTruthy();
  });

  it("names the violated fields when the binding proposal is refused with a validation 400 (Bulgu A)", async () => {
    // The BFF's strict DraftBody now answers `invalid_onboarding_body` WITH
    // `details.issues` — the field-level violations. The wizard must render
    // them under its translated sentence: the bare code left the operator
    // diffing an eight-field payload against a schema they cannot see.
    const { fetchImpl } = stubFetch(
      baseRoutes([
        {
          path: "/onboarding",
          method: "POST",
          status: 400,
          body: {
            error: "invalid_onboarding_body",
            details: { issues: ["triggerMode: Required", "platform: String must contain at least 1 character(s)"] },
          },
        },
      ]),
    );
    renderScreen(<SetupScreen />, { fetchImpl, session: ADMIN });

    await fillProject();
    await chooseFlow();
    await pickRepo();
    await fillTickets();
    await userEvent.click(await screen.findByRole("button", { name: "İleri" }));
    await skipIntake();
    await screen.findByText("Özet");
    await userEvent.click(screen.getByRole("button", { name: "Kurulumu tamamla" }));

    // The catalog sentence AND the named fields, on screen rather than in a
    // four-second toast.
    expect(await screen.findByText("triggerMode: Required")).toBeTruthy();
    expect(
      screen.getByText("platform: String must contain at least 1 character(s)"),
    ).toBeTruthy();
  });

  /**
   * TEKLİF ÖNCE, KURAL SONRA — ve kural düşerse teklif AYAKTA KALIR.
   *
   * Eski sözleşme tersiydi: "kural kaydedilmezse teklif asla dosyalanmaz".
   * Ölçüldü ve terk edildi: kural gövdesi depo eşlemesi taşıyor, sunucu o
   * deponun envanterde olmasını zorunlu tutuyor, envanteri yazan ise teklif
   * ucu. Kural önce gidince yeni depoyla ilk kurulum 6. adımda %100
   * düşüyordu — "tanınmayan depo", operatör depoyu kutudan seçmişken.
   *
   * Yeni sıranın bedeli: kural köşe durumda düşerse (çoğaltma) onaylayanın
   * kuyruğunda kuralsız bir teklif kalır. Bu görünür ve kurtarılabilir —
   * onaylayınca `seed-defaults` kuralları kendisi tohumlar. Sessiz bir
   * %100 arızaya karşı görünür bir köşe durumu: doğru taraf bu.
   */
  it("kural düşerse hata gösterilir; teklif ayakta kalır (envanter yazılmış olmalı)", async () => {
    const { fetchImpl, calls } = stubFetch(
      baseRoutes([
        {
          path: "/studio/listening-rules",
          method: "POST",
          status: 400,
          body: { error: "duplicate_listening_rule" },
        },
      ]),
    );
    renderScreen(<SetupScreen />, { fetchImpl });

    await fillProject();
    await chooseFlow();
    await pickRepo();
    await fillTickets();
    await userEvent.click(await screen.findByRole("button", { name: "İleri" }));
    await skipIntake();
    await screen.findByText("Özet");
    await userEvent.click(screen.getByRole("button", { name: "Kurulumu tamamla" }));
    await screen.findByText(/Bu ticket'lar için zaten bir dinleme kuralı var/);

    // Envanter (ve teklif) kuraldan ÖNCE yazıldı — sıra bu.
    const onboarding = calls.findIndex((c) => c.url.endsWith("/onboarding") && c.method === "POST");
    const rule = calls.findIndex((c) => c.url.endsWith("/studio/listening-rules") && c.method === "POST");
    expect(onboarding).toBeGreaterThanOrEqual(0);
    expect(rule).toBeGreaterThan(onboarding);
    // Kural düşünce onay DENENMEZ: onaysız teklif kuyrukta görünür kalır.
    expect(calls.find((c) => c.url.endsWith("/onboarding/approve"))).toBeUndefined();
  });

  /**
   * The English name beside the Turkish one.
   *
   * The whole feature is one rule with one failure mode, and it is the failure
   * mode we shipped and fixed today: the SAVED value must stay the localised
   * name Jira serves. `Görev` is what OPS-66 carries; a rule holding `Task` — or
   * `Görev (Task)` — matches nothing, silently, forever. So every test here
   * asserts BOTH halves in the same breath: what the operator read, and what
   * went on the wire.
   */
  describe("the English name beside the Turkish one", () => {
    it("labels the dropdown with both names while keeping the option's value Turkish", async () => {
      const { fetchImpl } = stubFetch(baseRoutes());
      renderScreen(<SetupScreen />, { fetchImpl });

      await fillProject();
      await chooseFlow();
      await pickRepo();
      await screen.findByText("Hangi ticket'ları alsın?");

      const select = (await screen.findByLabelText("Hangi değer?")) as HTMLSelectElement;
      const options = [...select.options].filter((o) => o.value !== "");
      // The label is what a bank employee running Jira in English can find…
      expect(options.map((o) => o.textContent)).toEqual([
        "Hata (Bug)",
        "Görev (Task)",
        // Jira serves this one untranslated, so there is nothing to add. An
        // invented aside here would be the module's one forbidden behaviour.
        "Alt görev (Subtask)",
      ]);
      // …and the value is what the rule will hold, untouched.
      expect(options.map((o) => o.value)).toEqual(OPS_ISSUE_TYPES);
    });

    it("saves the Turkish value even though the operator read the English one", async () => {
      const { fetchImpl, calls } = stubFetch(baseRoutes());
      renderScreen(<SetupScreen />, { fetchImpl });

      await fillProject();
      await chooseFlow();
      await pickRepo();
      // Picked through the label `Görev (Task)` — the exact pair that produced
      // the live bug when a rule was written from the English list.
      await fillTickets("Görev", "Görev (Task)");
      await userEvent.click(await screen.findByRole("button", { name: "İleri" }));
      await skipIntake();
      await screen.findByText("Özet");
      await userEvent.click(screen.getByRole("button", { name: "Kurulumu tamamla" }));

      await waitFor(() => {
        // `Görev`, not `Task`, and not `Görev (Task)`. This single assertion is
        // the reason the whole feature is presentation-only.
        expect(ruleBody(calls).matchValue).toBe("Görev");
      });
    });

    it("adds nothing for a name outside the standard set", async () => {
      const { fetchImpl } = stubFetch(
        baseRoutes([
          { path: "/onboarding/jira-match-values", body: { ok: true, values: ["Talep", "Hata"] } },
        ]),
      );
      renderScreen(<SetupScreen />, { fetchImpl });

      await fillProject();
      await chooseFlow();
      await pickRepo();
      await screen.findByText("Hangi ticket'ları alsın?");

      // A bank's own custom type. Guessing "Request" for it would be exactly
      // the confident wrong answer this screen must never produce.
      expect(await screen.findByRole("option", { name: "Talep" })).toBeTruthy();
      expect(screen.queryByRole("option", { name: /Talep \(/ })).toBeNull();
      // …while the name we HAVE measured still gets its aside.
      expect(screen.getByRole("option", { name: "Hata (Bug)" })).toBeTruthy();
    });
  });

  /**
   * "Bota atanan her ticket" — the third answer step 3 could not give.
   *
   * The measured gap: `ListeningRule.matchKind` allowed only status|issuetype,
   * so an operator whose real rule is "if a human hands it to the bot, work it"
   * had to invent a condition. Migration 0020 adds the third kind; these tests
   * pin the wizard's half of the round trip.
   */
  describe("every ticket assigned to the bot", () => {
    async function chooseAnyAssigned(): Promise<void> {
      await screen.findByText("Hangi ticket'ları alsın?");
      await userEvent.selectOptions(
        screen.getByLabelText("Ticket'ın nesine baksın?"),
        "assigned",
      );
    }

    it("drops the value question entirely rather than greying it out", async () => {
      const { fetchImpl } = stubFetch(baseRoutes());
      renderScreen(<SetupScreen />, { fetchImpl });

      await fillProject();
      await chooseFlow();
      await pickRepo();
      await screen.findByText("Hangi ticket'ları alsın?");
      // Present for the conditioned kinds …
      expect(screen.getByLabelText("Hangi değer?")).toBeTruthy();

      await chooseAnyAssigned();
      // … and GONE, not disabled, for the catch-all: a greyed box reads as a
      // form the operator failed to finish.
      expect(screen.queryByLabelText("Hangi değer?")).toBeNull();
    });

    it("lets the operator past step 3 with no value to give", async () => {
      const { fetchImpl } = stubFetch(baseRoutes());
      renderScreen(<SetupScreen />, { fetchImpl });

      await fillProject();
      await chooseFlow();
      await pickRepo();
      await chooseAnyAssigned();

      // The blocker that used to demand a match value must not fire here.
      expect(
        screen.queryByText("Devam etmek için Maestro'yu hangi değerin tetikleyeceğini belirtin."),
      ).toBeNull();
      const next = screen.getByRole("button", { name: "İleri" }) as HTMLButtonElement;
      expect(next.disabled).toBe(false);
    });

    it("summarises it as a rule with no condition, then saves it that way", async () => {
      const { fetchImpl, calls } = stubFetch(baseRoutes());
      renderScreen(<SetupScreen />, { fetchImpl });

      await fillProject();
      await chooseFlow();
      await pickRepo();
      await chooseAnyAssigned();
      await userEvent.click(screen.getByRole("button", { name: "İleri" }));
      await userEvent.click(await screen.findByRole("button", { name: "İleri" }));

      // Its OWN sentence — the conditioned one with an empty value spliced in
      // (`değeri "" olan ticket'lar`) would describe nothing.
      await skipIntake();
      await screen.findByText("Özet");
      expect(
        screen.getByText(
          "OPS projesinde bota atanan her ticket Yalnızca analiz akışıyla çalışacak; başka bir koşul aranmayacak.",
        ),
      ).toBeTruthy();

      await userEvent.click(screen.getByRole("button", { name: "Kurulumu tamamla" }));
      await waitFor(() => {
        const body = ruleBody(calls);
        expect(body.matchKind).toBe("assigned");
        // The placeholder both sides agree on. It is never compared to a
        // ticket; it exists so the unique trigger index keeps ONE catch-all
        // per (project, bot).
        expect(body.matchValue).toBe("*");
        expect(body.assigneeAccountId).toBe("712020:bot");
      });
    });
  });

  /**
   * The data class — the question that was never asked, and the measured cost
   * of not asking it.
   *
   * The wizard used to send no `dataClass` at all, so every binding it filed
   * came out `gizli`, and `packages/llm-gateway/src/policy.ts` then correctly
   * refused to send the content to a cloud model. SAM1-12 stalled with "modeli
   * kullanamadım, elle tamamlayın" and nothing on any screen named the cause;
   * moving SAM1 to `dahili` let SAM1-13 run analysis normally.
   */
  describe("the data class", () => {
    it("defaults to the safe-but-workable class, not the one that stops analysis", async () => {
      const { fetchImpl } = stubFetch(baseRoutes());
      renderScreen(<SetupScreen />, { fetchImpl });

      await screen.findByText("Hangi Jira projesi, hangi uygulama?");

      // The class is ONE select; the assertion is about which option is
      // selected, by its own value. It is the class that is safe AND lets
      // Maestro work — `gizli` was the old implicit answer and is the one that
      // stalled SAM1.
      const select = screen.getByLabelText("Bu uygulamanın verisi ne kadar gizli?") as HTMLSelectElement;
      expect(select.value).toBe("dahili");
      expect(select.selectedOptions[0]!.textContent).toBe("Kurum içi");
    });

    it("describes the consequence rather than the policy name", async () => {
      const { fetchImpl } = stubFetch(baseRoutes());
      renderScreen(<SetupScreen />, { fetchImpl });

      await screen.findByText("Hangi Jira projesi, hangi uygulama?");

      // The select's hint states the consequence of the CURRENT answer: the
      // default lets Maestro work, and no jargon stands in for it.
      expect(
        screen.getByText(/Bulut modeli kullanılabilir\. Maestro analiz ve kod üretimini normal şekilde yapar\./),
      ).toBeTruthy();
      expect(screen.queryByText(/degrade_ai_assist|ai_assist|M18/)).toBeNull();

      // Switching the answer switches the sentence — the one the operator
      // needed and never had, still with no policy name in it.
      await userEvent.selectOptions(screen.getByLabelText("Bu uygulamanın verisi ne kadar gizli?"), "gizli");
      expect(
        await screen.findByText(
          /Yapay zekâ bulut modeli KULLANILAMAZ\. Kurum içi \(on-prem\) model kurulu değilse Maestro bu projede analiz üretemez\./,
        ),
      ).toBeTruthy();
      expect(screen.queryByText(/degrade_ai_assist|ai_assist/)).toBeNull();
    });

    it("makes the gizli consequence unmissable, and only once it is chosen", async () => {
      const { fetchImpl } = stubFetch(baseRoutes());
      renderScreen(<SetupScreen />, { fetchImpl });

      await screen.findByText("Hangi Jira projesi, hangi uygulama?");
      expect(screen.queryByText(/modeli kullanamadım, elle tamamlayın/)).toBeNull();

      await userEvent.selectOptions(screen.getByLabelText("Bu uygulamanın verisi ne kadar gizli?"), "gizli");

      // The exact message the operator saw on SAM1-12, now quoted back BEFORE
      // they can cause it rather than after.
      expect(
        await screen.findByText(/modeli kullanamadım, elle tamamlayın/),
      ).toBeTruthy();
    });

    it("carries the operator's choice into the binding payload", async () => {
      const { fetchImpl, calls } = stubFetch(baseRoutes());
      renderScreen(<SetupScreen />, { fetchImpl });

      await screen.findByText("Hangi Jira projesi, hangi uygulama?");
      await userEvent.selectOptions(screen.getByLabelText("Bu uygulamanın verisi ne kadar gizli?"), "acik");
      await fillProject();
      await fillTickets();
      await userEvent.click(await screen.findByRole("button", { name: "İleri" }));

      // Stated on the summary before it is sent — the class decides whether a
      // cloud model may see the tickets, so it is not a hidden field.
      await skipIntake();
      await screen.findByText("Özet");
      expect(
        screen.getByText("Veri sınıfı: Açık — ticket içeriği her modele gönderilebilir."),
      ).toBeTruthy();

      await userEvent.click(screen.getByRole("button", { name: "Kurulumu tamamla" }));
      await waitFor(() => {
        const call = calls.find((c) => c.url.endsWith("/onboarding") && c.method === "POST");
        expect((call!.body as Record<string, unknown>).dataClass).toBe("acik");
      });
    });
  });

  /**
   * The start guide is NOT on the wizard any more.
   *
   * It was: a five-step welcome card above a five-step wizard, two numbered
   * lists on one page, and the operator read them as one broken list. The
   * wizard's own strip is the only list here; `StartGuide` keeps its own tests
   * in `screens-dash-start.test.tsx`.
   */
  describe("the start guide", () => {
    it("is not rendered on the wizard — one numbered list, the wizard's own", async () => {
      const { fetchImpl } = stubFetch(
        baseRoutes([
          { path: "/onboarding/scm-connections", body: { connections: [SCM_CONN] } },
          { path: "/variants", body: { variants: [] } },
        ]),
      );
      renderScreen(<SetupScreen />, { fetchImpl });

      await screen.findByText("Hangi Jira projesi, hangi uygulama?");
      expect(
        screen.queryByText("Hoş geldiniz — Maestro'yu 5 adımda çalışır hale getirin"),
      ).toBeNull();
      expect(screen.queryByText("Ticket girişini aç")).toBeNull();
      // Exactly one numbered list: the step strip.
      expect(screen.getAllByRole("list").length).toBe(1);
    });
  });

  /**
   * TAKIM YÖNETİMLİ PROJE — kural ADI değil KİMLİĞİ saklar.
   *
   * Dinleme kuralı formu bunu yapıyordu; sihirbaz yapmıyordu ve "Görev" adıyla
   * kaydettiği kural takım yönetimli projede sonsuza dek 0 ticket buluyordu.
   * İki ekran artık aynı yardımcıyı paylaşıyor (`common/match-value.ts`).
   */
  describe("team-managed project", () => {
    const teamManaged = () =>
      baseRoutes([
        {
          path: "/onboarding/jira-match-values",
          body: {
            ok: true,
            values: ["Hata", "Görev"],
            options: [
              { name: "Hata", id: "10007" },
              { name: "Görev", id: "10008" },
            ],
            teamManaged: true,
          },
        },
      ]);

    it("shows the name, stores the id, and summarises by name", async () => {
      const { fetchImpl, calls } = stubFetch(teamManaged());
      renderScreen(<SetupScreen />, { fetchImpl });

      await fillProject();
      await chooseFlow();
      await screen.findByText("Hangi ticket'ları alsın?");
      const select = (await screen.findByLabelText("Hangi değer?")) as HTMLSelectElement;
      await screen.findByRole("option", { name: "Görev (Task)" });
      // The operator reads names; the option VALUES are the ids JQL insists on.
      const options = [...select.options].filter((o) => o.value !== "");
      expect(options.map((o) => o.textContent)).toEqual(["Hata (Bug)", "Görev (Task)"]);
      expect(options.map((o) => o.value)).toEqual(["10007", "10008"]);
      expect(screen.getByText(/Bu proje takım yönetimli/)).toBeTruthy();
      await userEvent.selectOptions(select, "10008");
      await userEvent.click(screen.getByRole("button", { name: "İleri" }));
      await screen.findByText("Jira durumlarını da değiştirsin mi?");
      await userEvent.click(screen.getByRole("button", { name: "İleri" }));
      await skipIntake();

      // The summary prints the NAME — nobody can check "10008" against anything.
      await screen.findByText("Özet");
      expect(screen.getByText(/İş tipi değeri "Görev \(Task\)" olan ticket'lar/)).toBeTruthy();
      expect(screen.queryByText(/"10008"/)).toBeNull();

      await userEvent.click(screen.getByRole("button", { name: "Kurulumu tamamla" }));
      await waitFor(() => expect(ruleBody(calls).matchValue).toBe("10008"));
      // And the done screen keeps reading by name.
      expect(await screen.findByText(/İş tipi değeri "Görev \(Task\)" olan bir ticket açın/)).toBeTruthy();
    });

    it("keeps storing the name on a company-managed project, ids or not", async () => {
      const { fetchImpl, calls } = stubFetch(
        baseRoutes([
          {
            path: "/onboarding/jira-match-values",
            body: {
              ok: true,
              values: ["Hata", "Görev"],
              options: [
                { name: "Hata", id: "10007" },
                { name: "Görev", id: "10008" },
              ],
              teamManaged: false,
            },
          },
        ]),
      );
      renderScreen(<SetupScreen />, { fetchImpl });

      await fillProject();
      await chooseFlow();
      await fillTickets("Görev", "Görev (Task)");
      await userEvent.click(await screen.findByRole("button", { name: "İleri" }));
      await skipIntake();
      await screen.findByText("Özet");
      await userEvent.click(screen.getByRole("button", { name: "Kurulumu tamamla" }));
      await waitFor(() => expect(ruleBody(calls).matchValue).toBe("Görev"));
    });

    it("adds the status trigger to the pool by NAME even when the rule stores its id", async () => {
      const { fetchImpl, calls } = stubFetch(
        baseRoutes([
          {
            path: "/onboarding/jira-match-values",
            body: {
              ok: true,
              values: ["Yapılacaklar", "Tamam"],
              options: [
                { name: "Yapılacaklar", id: "10004" },
                { name: "Tamam", id: "10005" },
              ],
              teamManaged: true,
            },
          },
        ]),
      );
      renderScreen(<SetupScreen />, { fetchImpl });

      await fillProject();
      await chooseFlow();
      await userEvent.selectOptions(screen.getByLabelText("Ticket'ın nesine baksın?"), "status");
      await screen.findByRole("option", { name: "Yapılacaklar (To Do)" });
      await userEvent.selectOptions(screen.getByLabelText("Hangi değer?"), "10004");
      // The pool is a list of NAMES: the trigger joined it by name.
      expect((screen.getByLabelText("Yapılacaklar") as HTMLInputElement).checked).toBe(true);
      await userEvent.click(screen.getByRole("button", { name: "İleri" }));
      // A pool needs an exit: fill the map so step 3 lets us through.
      await screen.findByText("Jira durumlarını da değiştirsin mi?");
      await userEvent.click(screen.getByLabelText("Ticket'ın Jira durumunu da değiştirsin"));
      await userEvent.selectOptions(await screen.findByLabelText("İş bittiğinde"), "Tamam");
      await userEvent.selectOptions(screen.getByLabelText("Bilgi eksik olduğunda"), "Tamam");
      await userEvent.click(screen.getByRole("button", { name: "İleri" }));
      await skipIntake();
      await screen.findByText("Özet");
      await userEvent.click(screen.getByRole("button", { name: "Kurulumu tamamla" }));
      await waitFor(() => {
        const body = ruleBody(calls);
        expect(body.matchValue).toBe("10004");
        expect(body.allowedStatuses).toEqual(["Yapılacaklar"]);
      });
    });
  });

  /** The pre-filled bot account is a LINE, not a box, until asked to change. */
  describe("the bot account", () => {
    it("shows the auto-filled id read-only, with a change button that opens the box", async () => {
      const { fetchImpl } = stubFetch(baseRoutes());
      renderScreen(<SetupScreen />, { fetchImpl });

      await fillProject();
      await chooseFlow();
      expect(await screen.findByText("712020:bot")).toBeTruthy();
      expect(screen.queryByLabelText("Bot kullanıcısı (Jira hesap kimliği)")).toBeNull();

      await userEvent.click(screen.getByRole("button", { name: "Değiştir" }));
      const box = (await screen.findByLabelText("Bot kullanıcısı (Jira hesap kimliği)")) as HTMLInputElement;
      expect(box.value).toBe("712020:bot");
    });

    it("asks for it in a box when no connection has reported one", async () => {
      const { fetchImpl } = stubFetch(
        baseRoutes([
          { path: "/onboarding/jira-connections", body: { connections: [{ ...JIRA_CONN, botAccountId: null }] } },
        ]),
      );
      renderScreen(<SetupScreen />, { fetchImpl });

      await fillProject();
      await chooseFlow();
      expect(await screen.findByLabelText("Bot kullanıcısı (Jira hesap kimliği)")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Değiştir" })).toBeNull();
    });
  });
});

/**
 * The analysis-only setup (repo optional for the `analiz` flow).
 *
 * The audience this exists for is the first pilot's actual shape: a team that
 * wants analysis documents on its Jira tickets and owns no code repository.
 * Until this change the wizard demanded an SCM connection, a repository and a
 * platform for every flow — "Maestro'nun kodu nereye yazacağını bilmeden
 * kurulum yapılamaz", a sentence that is simply false for `analiz`.
 */
describe("setup wizard — analysis without a repository", () => {
  /** An install with NO repository connection at all. */
  const noScm = () =>
    baseRoutes([{ path: "/onboarding/scm-connections", body: { connections: [] } }]);

  it("walks step 2 without a repository, says the offer is optional, and files a repo-less binding", async () => {
    const { fetchImpl, calls } = stubFetch(noScm());
    renderScreen(<SetupScreen />, { fetchImpl });

    await fillProject();
    // Step 2: analiz is the default and nothing about the flow is blocked
    // despite zero SCM connections — the prerequisite is per-flow. The repo
    // is an OFFER, named as such, and with no connection there is no empty
    // select to hold the operator hostage.
    await chooseFlow();
    expect(
      screen.getByText(/İsteğe bağlı: bir kod deposu bağlarsanız etki analizi dosyalara bakılarak yazılır/),
    ).toBeTruthy();
    expect(screen.queryByLabelText(/Kod deposu/)).toBeNull();
    // The code card carries its reason (shown, never hidden); nothing blocks İleri for it.
    expect(screen.getAllByText(/bir kod deposu bağlantısı gerekir/).length).toBe(1);

    await fillTickets();
    await screen.findByText("Jira durumlarını da değiştirsin mi?");
    await userEvent.click(screen.getByRole("button", { name: "İleri" }));
    await skipIntake();

    // The summary says WHICH MODE the binding is in — ticket-text — instead of
    // a repo sentence with a hole in it.
    await screen.findByText("Özet");
    expect(
      screen.getByText(/OPS projesine kod deposu bağlanmayacak: analiz belgesi yalnızca ticket metninden üretilecek/),
    ).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Kurulumu tamamla" }));

    await waitFor(() => {
      // The rule carries the analiz flow…
      const body = ruleBody(calls);
      expect(body.flowType).toBe("analiz");
      // …and the binding proposal carries NO repo half at all — omitted, not "".
      const call = calls.find((c) => c.url.endsWith("/onboarding") && c.method === "POST");
      expect(call, "no binding proposal was filed").toBeTruthy();
      expect(call!.body).toEqual({
        jiraProject: "OPS",
        triggerMode: "opt_in",
        gateSet: "risk_tiered",
        mergeMode: "human",
        dataClass: "dahili",
      });
    });
  });

  it("keeps repo mode when the analiz operator DOES pick a repository (regression)", async () => {
    const { fetchImpl, calls } = stubFetch(baseRoutes());
    renderScreen(<SetupScreen />, { fetchImpl });

    await fillProject();
    await chooseFlow(); // analiz
    // The offer, on the same field the code flow requires — labelled as optional.
    expect(await screen.findByLabelText("Kod deposu (analiz kodu okusun diye, isteğe bağlı)")).toBeTruthy();
    await pickRepo();
    await fillTickets();
    await userEvent.click(await screen.findByRole("button", { name: "İleri" }));
    await skipIntake();
    await screen.findByText("Özet");
    // Repo mode's own sentence, not the ticket-text one: picking the repo
    // accepted the offer — and it says the analysis READS that code, rather
    // than claiming the application will be built and tested.
    expect(
      screen.getByText(/Uguryldz\/maestro-pilot deposuna bağlanacak: analiz o deponun kodu okunarak yapılacak/),
    ).toBeTruthy();
    expect(screen.queryByText(/kod deposu bağlanmayacak/)).toBeNull();
    expect(screen.queryByText(/derlenip test edilecek/)).toBeNull();
    expect(screen.queryByText(/Maestro hiçbir koda bakmayacak/)).toBeNull();
    // Nothing is merged on an analysis flow, so no merge sentence either.
    expect(screen.queryByText(/Merge/)).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Kurulumu tamamla" }));
    await waitFor(() => {
      const call = calls.find((c) => c.url.endsWith("/onboarding") && c.method === "POST");
      expect(call!.body).toMatchObject({
        adoRepo: "Uguryldz/maestro-pilot",
        platform: "linux-node",
      });
    });
  });

  it("pre-selects the sole repository connection, and an untouched list still means no repository", async () => {
    const { fetchImpl, calls } = stubFetch(baseRoutes());
    renderScreen(<SetupScreen />, { fetchImpl });

    await fillProject();
    await chooseFlow(); // analiz
    // The list is already open — no "Kod deposu bağlantısı" question stood in
    // front of it — and its empty row says what leaving it means.
    expect(await screen.findByRole("option", { name: "Uguryldz/maestro-pilot" })).toBeTruthy();
    expect(screen.queryByLabelText("Kod deposu bağlantısı")).toBeNull();
    expect(screen.getByRole("option", { name: /Depo bağlanmasın/ })).toBeTruthy();
    // A pre-selected connection is not "half a repository": nothing blocks.
    expect(screen.queryByText("Devam etmek için kodun yazılacağı depoyu seçin.")).toBeNull();

    await fillTickets();
    await userEvent.click(await screen.findByRole("button", { name: "İleri" }));
    await skipIntake();
    await screen.findByText("Özet");
    expect(screen.getByText(/OPS projesine kod deposu bağlanmayacak/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Kurulumu tamamla" }));
    await waitFor(() => {
      const call = calls.find((c) => c.url.endsWith("/onboarding") && c.method === "POST");
      expect(call!.body).not.toHaveProperty("adoRepo");
      expect(ruleBody(calls)).not.toHaveProperty("repoMap");
    });
  });

  it("asks for the connection only when there is a real choice, and finishes a started pick", async () => {
    const { fetchImpl } = stubFetch(
      baseRoutes([
        {
          path: "/onboarding/scm-connections",
          body: { connections: [SCM_CONN, { ...SCM_CONN, id: "scm-2", displayName: "İkinci GitHub" }] },
        },
      ]),
    );
    renderScreen(<SetupScreen />, { fetchImpl });

    await fillProject();
    await chooseFlow("gelistirme");
    // Two connections: the question is asked, and the code flow needs it answered.
    expect(screen.getByText("Devam etmek için bir kod deposu bağlantısı seçin.")).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText("Kod deposu bağlantısı"), "scm-1");
    await screen.findByRole("option", { name: "Uguryldz/maestro-pilot" });
    // The connection alone is HALF a repository for a code flow: named as such.
    expect(screen.getByText("Devam etmek için kodun yazılacağı depoyu seçin.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "İleri" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("still blocks the code flow without a repository connection on the same install (regression)", async () => {
    const { fetchImpl } = stubFetch(noScm());
    renderScreen(<SetupScreen />, { fetchImpl });

    await fillProject();
    await screen.findByText("Hangi ticket'ları alsın?");
    await userEvent.click(screen.getByRole("radio", { name: /Analiz \+ kod \+ PR/ }));
    await screen.findAllByText(/bir kod deposu bağlantısı gerekir ve bu kurulumda henüz tanımlı değil/);
    expect((screen.getByRole("button", { name: "İleri" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

/**
 * Step 5 — "Onaylar Maestro'ya nasıl ulaşsın?".
 *
 * The failure this step closes is the most expensive one on the platform.
 * `/approve` written on a ticket is the documented way to pass a gate, and
 * whether it was ever READ depended on `JIRA_POLL_MS` — an environment variable
 * in a file on a server a bank operator has no shell on. So a run reached a
 * gate, a human approved it in the only place they had been told to, and the
 * gate waited forever with nothing anywhere naming the cause.
 *
 * What is worth testing is therefore not "does a radio render" but the promises
 * this step makes: that the answer is SAVED where the platform reads it, that
 * an unchanged answer writes nothing, that an install which cannot poll is told
 * so instead of being allowed to pick it, and that the operator learns when the
 * change takes effect rather than being left to find out from a stuck ticket.
 */
describe("setup wizard — how approvals arrive", () => {
  /** A platform whose driver cannot read comments, so polling is impossible. */
  function noReader(): Route[] {
    return baseRoutes([
      {
        path: "/studio/command-intake",
        body: {
          mode: "webhook",
          pollSeconds: 0,
          canReadComments: false,
          appliesLive: true,
          source: "default",
        },
      },
    ]);
  }

  /** Walk to step 5 with the shortest possible path. */
  async function reachIntake(routes: readonly Route[] = baseRoutes()): Promise<
    ReturnType<typeof stubFetch>
  > {
    const stub = stubFetch(routes);
    renderScreen(<SetupScreen />, { fetchImpl: stub.fetchImpl });
    await fillProject();
    await chooseFlow();
    await pickRepo();
    await fillTickets();
    await screen.findByText("Jira durumlarını da değiştirsin mi?");
    await userEvent.click(screen.getByRole("button", { name: "İleri" }));
    await screen.findByText("Onaylar Maestro'ya nasıl ulaşsın?");
    return stub;
  }

  /** Every PUT /settings the wizard made. */
  function settingsCalls(
    calls: readonly { url: string; method: string; body: unknown }[],
  ): { url: string; method: string; body: unknown }[] {
    return calls.filter((c) => c.url.endsWith("/settings") && c.method === "PUT");
  }

  it("asks the question in outcome language, with no environment variable in sight", async () => {
    await reachIntake();

    // The three answers, each said as what it DOES rather than as its mechanism.
    expect(screen.getByRole("radio", { name: /Jira bize haber versin/ })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /Biz Jira'ya soralım/ })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /İkisi birden/ })).toBeTruthy();
    // The whole point of the step: an operator never has to know this name.
    expect(screen.queryByText(/JIRA_POLL_MS/)).toBeNull();
  });

  /**
   * The wizard opens on what the PLATFORM does, not on its own preference.
   * Showing "webhook" to an install that has been polling for months is a lie
   * the operator would then save back over a working configuration.
   */
  it("opens on the answer that is already in force", async () => {
    await reachIntake(
      baseRoutes([
        {
          path: "/studio/command-intake",
          body: {
            mode: "poll",
            pollSeconds: 90,
            canReadComments: true,
            appliesLive: true,
            source: "env",
          },
        },
      ]),
    );

    expect(
      (screen.getByRole("radio", { name: /Biz Jira'ya soralım/ }) as HTMLInputElement).checked,
    ).toBe(true);
    expect((screen.getByLabelText("Sorma aralığı (saniye)") as HTMLInputElement).value).toBe("90");
  });

  /** The interval is only asked for when something will actually read it. */
  it("asks for an interval only once an answer that polls is chosen", async () => {
    await reachIntake();
    expect(screen.queryByLabelText("Sorma aralığı (saniye)")).toBeNull();

    await userEvent.click(screen.getByRole("radio", { name: /Biz Jira'ya soralım/ }));
    expect(await screen.findByLabelText("Sorma aralığı (saniye)")).toBeTruthy();
    // The cost of the answer, stated where the answer is given.
    expect(screen.getByText(/yoklama Jira'ya yük bindirir/)).toBeTruthy();
  });

  it("saves the chosen intake and interval as the platform's own parameters", async () => {
    const { calls } = await reachIntake();

    await userEvent.click(screen.getByRole("radio", { name: /Biz Jira'ya soralım/ }));
    const seconds = await screen.findByLabelText("Sorma aralığı (saniye)");
    await userEvent.clear(seconds);
    await userEvent.type(seconds, "120");
    await userEvent.click(screen.getByRole("button", { name: "İleri" }));

    await screen.findByText("Özet");
    await userEvent.click(screen.getByRole("button", { name: "Kurulumu tamamla" }));

    await waitFor(() => {
      const put = settingsCalls(calls);
      expect(put).toHaveLength(1);
      const changes = (put[0]!.body as { changes: { key: string; value: unknown }[] }).changes;
      expect(changes).toEqual([
        { key: "jira.command_intake", scopeRef: null, value: "poll" },
        { key: "jira.poll_seconds", scopeRef: null, value: 120 },
      ]);
    });
  });

  /**
   * A GLOBAL setting in a per-project wizard. An operator adding their fourth
   * project must not mint a new parameter version — and a new audit row — for a
   * value nobody touched.
   */
  it("writes no parameter at all when the answer was not changed", async () => {
    const { calls } = await reachIntake();

    await userEvent.click(screen.getByRole("button", { name: "İleri" }));
    await screen.findByText("Özet");
    await userEvent.click(screen.getByRole("button", { name: "Kurulumu tamamla" }));

    await screen.findByText("Kurulum tamam");
    expect(settingsCalls(calls)).toHaveLength(0);
  });

  /**
   * Switching polling OFF must not leave an interval behind that reads as
   * "still polling"; the mode is what decides, and zero says so on the wire.
   */
  it("sends a zero interval when the operator goes back to webhook-only", async () => {
    const { calls } = await reachIntake(
      baseRoutes([
        {
          path: "/studio/command-intake",
          body: {
            mode: "poll",
            pollSeconds: 60,
            canReadComments: true,
            appliesLive: true,
            source: "param",
          },
        },
      ]),
    );

    await userEvent.click(screen.getByRole("radio", { name: /Jira bize haber versin/ }));
    await userEvent.click(screen.getByRole("button", { name: "İleri" }));
    await screen.findByText("Özet");
    await userEvent.click(screen.getByRole("button", { name: "Kurulumu tamamla" }));

    await waitFor(() => {
      const changes = (settingsCalls(calls)[0]!.body as {
        changes: { key: string; value: unknown }[];
      }).changes;
      expect(changes[0]!.value).toBe("webhook");
      expect(changes[1]!.value).toBe(0);
    });
  });

  /**
   * THE capability test. Silently accepting an answer that cannot work is the
   * worst outcome available on this screen: the operator would leave believing
   * approvals are read, and the gate would wait forever exactly as before.
   */
  it("names why polling is unavailable and refuses to move on with it", async () => {
    await reachIntake(noReader());

    // Shown and explained, never hidden: an operator has to be able to see the
    // answer to "why can't I poll?".
    expect(screen.getByRole("radio", { name: /Biz Jira'ya soralım/ })).toBeTruthy();
    await userEvent.click(screen.getByRole("radio", { name: /Biz Jira'ya soralım/ }));

    await screen.findAllByText(/tanımlı iş bağlantısı ticket yorumlarını okuyamıyor/);
    expect((screen.getByRole("button", { name: "İleri" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("still lets the webhook answer through on an install that cannot poll", async () => {
    await reachIntake(noReader());
    expect((screen.getByRole("button", { name: "İleri" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  /**
   * An unreached or failed capability read is UNKNOWN, not "cannot". Telling an
   * operator their driver cannot poll on the strength of a 404 would push them
   * back onto the webhook — the path that was already failing when they came to
   * this screen.
   */
  it("does not accuse the driver of anything while the capability is unknown", async () => {
    // No /studio/command-intake route at all: the harness answers 404.
    await reachIntake(
      baseRoutes().filter((r) => r.path !== "/studio/command-intake"),
    );

    await userEvent.click(screen.getByRole("radio", { name: /Biz Jira'ya soralım/ }));
    expect(screen.queryByText(/ticket yorumlarını okuyamıyor/)).toBeNull();
    expect((screen.getByRole("button", { name: "İleri" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  /** An interval below the floor is a Jira outage, not a setting. */
  it("refuses an interval that would hammer the bank's Jira", async () => {
    await reachIntake();
    await userEvent.click(screen.getByRole("radio", { name: /Biz Jira'ya soralım/ }));
    const seconds = await screen.findByLabelText("Sorma aralığı (saniye)");
    await userEvent.clear(seconds);
    await userEvent.type(seconds, "2");

    expect(screen.getByText(/Sorma aralığı çok kısa/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "İleri" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("refuses an interval so long the approval would sit for hours", async () => {
    await reachIntake();
    await userEvent.click(screen.getByRole("radio", { name: /Biz Jira'ya soralım/ }));
    const seconds = await screen.findByLabelText("Sorma aralığı (saniye)");
    await userEvent.clear(seconds);
    await userEvent.type(seconds, "99999");

    expect(screen.getByText(/Sorma aralığı çok uzun/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "İleri" }) as HTMLButtonElement).disabled).toBe(true);
  });

  /**
   * "İkisi birden" is the answer that raises the obvious question — will my
   * approval be acted on twice? The operator is entitled to read the mechanism,
   * not to be told to trust the platform.
   */
  it("explains the double-processing guard when both paths are chosen", async () => {
    await reachIntake();
    expect(screen.queryByText(/Aynı onay iki kez işlenmez/)).toBeNull();

    await userEvent.click(screen.getByRole("radio", { name: /İkisi birden/ }));
    expect(await screen.findByText(/Aynı onay iki kez işlenmez/)).toBeTruthy();
  });

  /**
   * WHEN the change applies, read from the platform rather than assumed.
   * Promising "hemen geçerli" on a deployment that needs a restart leaves an
   * operator approving tickets into a void — the same silent wait this step
   * exists to end.
   */
  it("promises a live change only when the platform reports one", async () => {
    await reachIntake();
    expect(screen.getByText(/kaydedildiği anda geçerli olur/)).toBeTruthy();
  });

  it("says a restart is needed when the platform says so", async () => {
    await reachIntake(
      baseRoutes([
        {
          path: "/studio/command-intake",
          body: {
            mode: "webhook",
            pollSeconds: 0,
            canReadComments: true,
            appliesLive: false,
            source: "default",
          },
        },
      ]),
    );

    expect(
      screen.getByText(/ancak Maestro servisi yeniden başlatıldıktan sonra geçerli olur/),
    ).toBeTruthy();
  });

  /** The one answer here that is not about the project being configured. */
  it("warns that the choice is platform-wide, not per-project", async () => {
    await reachIntake();
    expect(screen.getByText(/Bu seçim tüm platform için geçerlidir/)).toBeTruthy();
  });

  /** The summary the operator signs off on has to carry this answer too. */
  it("summarises the chosen intake before the save button", async () => {
    await reachIntake();
    await userEvent.click(screen.getByRole("radio", { name: /Biz Jira'ya soralım/ }));
    await userEvent.click(screen.getByRole("button", { name: "İleri" }));

    await screen.findByText("Özet");
    expect(screen.getByText(/belirli aralıklarla Jira'ya sorarak alacak/)).toBeTruthy();
    expect(screen.getByText("Sorma aralığı: 60 saniye.")).toBeTruthy();
  });
});

/**
 * ── SİHİRBAZ KAPI STATÜLERİNİ SORUYOR ────────────────────────────────────────
 *
 * Sahadaki arızanın kök sebebi: sihirbaz `GATE_STATUS_POINTS`i HİÇ sormuyordu,
 * dolayısıyla ondan geçen her kurulumun kapı kanalı kapalı kalıyordu — ve
 * kapalı olduğunu söyleyen bir cümle hiçbir ekranda yoktu. Operatör
 * "analysisapproval → analiz" akışını panodan yönetmek istiyor; o akışın
 * TAMAMI bu iki alana bağlı.
 */
describe("kurulum sihirbazı — kapı kararının statüyle verilmesi", () => {
  function statusRoutes(): Route[] {
    return baseRoutes([
      { path: "/onboarding/jira-match-values", body: { ok: false, messageKey: "error.unexpected" } },
    ]);
  }

  async function reachStatusStep(): Promise<void> {
    await fillProject();
    await chooseFlow();
    await pickRepo();
    await screen.findByText("Hangi ticket'ları alsın?");
    await userEvent.type(screen.getByLabelText("Hangi değer?"), "Hata");
    await userEvent.click(screen.getByRole("button", { name: "İleri" }));
    await screen.findByText("Jira durumlarını da değiştirsin mi?");
  }

  /**
   * ── BU DOSYANIN EN ÖNEMLİ TESTİ, VE SORDUĞU SORU DEĞİŞTİ ────────────────
   *
   * Eskiden "iki kapı alanı anahtar kapalıyken de GÖRÜNÜYOR mu" diye
   * soruyordu. Alanlar görünür yapıldı, ve operatör bu kez şunu söyledi:
   * "kapı onayı ÇAKIŞIK yazdı… şu dinleme ayarları çok karmaşık oldu."
   *
   * Kök sebep alanların görünürlüğü değil, VAR OLMALARIYDI: operatörden aynı
   * hattı ikinci kez tarif etmelerini istiyorlardı, ve üstelik doğru
   * doldurulmuş bir hat çakışma koruması yüzünden reddediliyordu.
   *
   * Artık soru YOK, CEVAP var: sihirbaz beş alanı soruyor, kapının iki kenarını
   * onlardan türetip geri söylüyor.
   */
  it("kapı alanlarını SORMUYOR — kenarları beş alandan türetip gösteriyor", async () => {
    const { fetchImpl } = stubFetch(statusRoutes());
    renderScreen(<SetupScreen />, { fetchImpl });
    await reachStatusStep();

    // Ayrı kutular ARTIK YOK.
    expect(screen.queryByLabelText("Buraya taşınırsa: onaylandı")).toBeNull();
    expect(screen.queryByLabelText("Buraya taşınırsa: analize geri gönder")).toBeNull();

    // Hattı çiz, kenarların türetildiğini gör.
    await userEvent.click(screen.getByLabelText(/Jira durumunu da değiştir/));
    await userEvent.type(screen.getByLabelText("İş başladığında"), "analiz");
    await userEvent.type(screen.getByLabelText("İş bittiğinde"), "development");

    expect(screen.getByText(/development durumuna taşımak/)).toBeTruthy();
    expect(screen.getByText(/analiz durumuna taşımak/)).toBeTruthy();
  });

  it("hiçbir kenar türetilemiyorsa UYARIYOR — kapı yalnız yorumla kapanır", async () => {
    const { fetchImpl } = stubFetch(statusRoutes());
    renderScreen(<SetupScreen />, { fetchImpl });
    await reachStatusStep();

    // Eşleme KAPALIYKEN: kapı yalnız yorumla kapanır, ve bunu açıkça söylüyor.
    expect(
      screen.getByText(/Statü eşlemesi kapalı: kapı kararı yalnız ticket'a yazılan \/approve ve \/reject yorumlarıyla verilir/),
    ).toBeTruthy();
    expect(screen.queryByText(/Kapının iki kenarı da BOŞ/)).toBeNull();

    // Eşleme AÇIK ama beş alan boşken: iki kenar da türetilemiyor, ve hangi
    // alanların doldurulması gerektiğini söylüyor.
    await userEvent.click(screen.getByLabelText(/Jira durumunu da değiştir/));
    expect(await screen.findByText(/Kapının iki kenarı da BOŞ/)).toBeTruthy();
    expect(screen.queryByText(/Statü eşlemesi kapalı/)).toBeNull();
  });

  /**
   * ── OPERATÖRÜN HATTI, SİHİRBAZDAN UÇTAN UCA ────────────────────────────
   *
   * Beş alan dolduruluyor, ayrı bir kapı alanı GİRİLMİYOR, ve kaydedilen kural
   * yalnız o beş alanı taşıyor. Özet de kapının ne yapacağını söylüyor.
   */
  it("beş alanlık hattı kaydeder ve özette kapının ne yapacağını söyler", async () => {
    const { fetchImpl, calls } = stubFetch(statusRoutes());
    renderScreen(<SetupScreen />, { fetchImpl });
    await reachStatusStep();

    await userEvent.click(screen.getByLabelText(/Jira durumunu da değiştir/));
    await userEvent.type(screen.getByLabelText("İş başladığında"), "analiz");
    await userEvent.type(screen.getByLabelText("Bilgi eksik olduğunda"), "todo");
    await userEvent.type(screen.getByLabelText("Analiz onaya çıktığında"), "analysisapproval");
    await userEvent.type(screen.getByLabelText("İş bittiğinde"), "development");
    await userEvent.click(screen.getByRole("button", { name: "İleri" }));

    await skipIntake();
    await screen.findByText("Özet");
    // Operatörün İMZALADIĞI şey: kapının iki kenarı, türetildikleri alan adıyla.
    expect(screen.getByText(/“development” durumuna taşımak onay sayılır/)).toBeTruthy();
    expect(screen.getByText(/“analiz” durumuna taşımak analizi baştan yazdırır/)).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Kurulumu tamamla" }));
    await waitFor(() => {
      // Ayrı kapı alanı YOK — beş alan hattın tamamını taşıyor.
      expect(ruleBody(calls).statusMap).toEqual({
        onStart: "analiz",
        onNeedInfo: "todo",
        onReview: "analysisapproval",
        onDone: "development",
      });
    });
  });

  it("özet, kapı kanalı boşken bunu AÇIKÇA söyler — sessizlik sahada arıza oldu", async () => {
    const { fetchImpl } = stubFetch(statusRoutes());
    renderScreen(<SetupScreen />, { fetchImpl });
    await reachStatusStep();
    await userEvent.click(screen.getByRole("button", { name: "İleri" }));
    await skipIntake();
    await screen.findByText("Özet");

    // Ve NEDEN boş olduğunu da söylüyor: hangi alanları doldurması gerektiği,
    // "hayır" cevabının yanında duruyor. Sessizlik sahada arıza oldu; eksik bir
    // "hayır" da olurdu.
    expect(
      screen.getByText(/"İş bittiğinde" ve "Ret gelince"\/"İş başladığında" alanları boş/),
    ).toBeTruthy();
  });
});

/**
 * İNSAN ONAYI RADYOSU — "PR'ı istersem kapatabileyim".
 *
 * Operatörün isteği buydu. Ekran onun yerine altı kutuluk bir liste ve "risk
 * seviyesine göre mi, ben mi seçiyorum" diye ikinci bir soru soruyordu; üstelik
 * katlanmış bir `<details>` içinde, yani seçeneğin var olduğu hiç görünmüyordu.
 *
 * Bu testler üç cevabın TELDE ne taşıdığını ölçüyor — ekranın ne gösterdiğini
 * değil. Karşılık yanlışsa kapı yanlış açılır ve bunu kimse fark etmez.
 */
describe("insan onayı radyosu", () => {
  async function gateBody(choice: string, flow?: "gelistirme"): Promise<Record<string, unknown>> {
    const { fetchImpl, calls } = stubFetch(baseRoutes());
    renderScreen(<SetupScreen />, { fetchImpl });

    await fillProject();
    await chooseFlow(flow);
    await pickRepo();
    // Radyo `tickets` adımında: `fillTickets` sonunda "İleri"ye bastığı için
    // onun yerine adımı elle dolduruyoruz.
    await screen.findByText("Hangi ticket'ları alsın?");
    await screen.findByRole("option", { name: "Hata (Bug)" });
    await userEvent.selectOptions(screen.getByLabelText("Hangi değer?"), "Hata");
    await userEvent.click(screen.getByRole("radio", { name: new RegExp(choice, "u") }));
    await userEvent.click(screen.getByRole("button", { name: "İleri" }));
    // 3. adım (Jira durumları) isteğe bağlı — dokunmadan geçiliyor.
    await screen.findByText("Jira durumlarını da değiştirsin mi?");
    await userEvent.click(screen.getByRole("button", { name: "İleri" }));
    await skipIntake();
    await screen.findByText("Özet");
    await userEvent.click(screen.getByRole("button", { name: "Kurulumu tamamla" }));

    let body: Record<string, unknown> = {};
    await waitFor(() => {
      const call = calls.find((c) => c.url.endsWith("/studio/listening-rules") && c.method === "POST");
      expect(call, "kural kaydedilmedi").toBeTruthy();
      body = call!.body as Record<string, unknown>;
    });
    return body;
  }

  it("Yok → hiçbir kapı açılmaz ({steps: []})", async () => {
    expect((await gateBody("Yok"))["gateSteps"]).toEqual({ steps: [] });
  });

  it("Analiz bitince → yalnız teknik lider kapısı ({steps: ['5']})", async () => {
    expect((await gateBody("Analiz bitince"))["gateSteps"]).toEqual({ steps: ["5"] });
  });

  it("Analiz + PR öncesi → iki kapı ({steps: ['5','12']})", async () => {
    // Kapı 12 "PR (birleştirme) onayı" — operatörün kapatmak istediği kapı.
    // Yalnız kod yazan akışta sunulur: analiz akışı PR açmaz.
    expect((await gateBody("Analiz \\+ PR öncesi", "gelistirme"))["gateSteps"]).toEqual({ steps: ["5", "12"] });
  });

  it("Yalnızca analiz akışında 'Analiz + PR öncesi' sunulmaz; akış analize dönerse seçim 'Analiz bitince'ye düşer", async () => {
    const { fetchImpl } = stubFetch(baseRoutes());
    renderScreen(<SetupScreen />, { fetchImpl });

    await fillProject();
    await chooseFlow();
    // Başlık "İnsan onayı" değil: iletişim adımıyla karışmasın diye.
    expect(screen.getByText("Hangi onaylar beklensin")).toBeTruthy();
    expect(screen.queryByRole("radio", { name: /Analiz \+ PR öncesi/ })).toBeNull();
    expect(screen.getByRole("radio", { name: /^Yok/ })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /Analiz bitince/ })).toBeTruthy();

    await userEvent.click(screen.getByRole("radio", { name: /Analiz \+ kod \+ PR/ }));
    await userEvent.click(await screen.findByRole("radio", { name: /Analiz \+ PR öncesi/ }));
    expect((screen.getByRole("radio", { name: /Analiz \+ PR öncesi/ }) as HTMLInputElement).checked).toBe(true);

    await userEvent.click(screen.getByRole("radio", { name: /Yalnızca analiz/ }));
    expect(screen.queryByRole("radio", { name: /Analiz \+ PR öncesi/ })).toBeNull();
    expect((screen.getByRole("radio", { name: /Analiz bitince/ }) as HTMLInputElement).checked).toBe(true);
  });

  it("HER ZAMAN {steps} gönderilir, null ASLA", async () => {
    // `null` "operatör seçmedi" demek ve kapı dizisini risk katmanına bırakır.
    // Radyoda bir seçenek hep seçili olduğu için operatör her zaman seçmiştir;
    // `null` göndermek sorduğu soruyu sonra yok saymak olurdu.
    for (const choice of ["Yok", "Analiz bitince"]) {
      expect((await gateBody(choice))["gateSteps"]).not.toBeNull();
    }
  });
});

/**
 * HAVUZ ÇIKIŞI — arıza 3. adımda görünür, 5. adımda DEĞİL.
 *
 * Ölçülmüş arıza: operatör 2. adımda bir statü seçiyor (havuz kuruluyor),
 * 3. adım "isteğe bağlı" diye etiketli olduğu için atlıyor, ve 5. adımda
 * `400 listening_pool_without_exit` yiyor — dört adım geç, üstelik atlamasının
 * söylendiği bir kutuyu doldurmak için geri dönerek.
 *
 * Kural sunucununkiyle AYNI fonksiyondan geliyor (`poolExitGaps`,
 * `@maestro/contracts`) — kopya değil. Kopyalanmış bir doğrulama ayrışır ve
 * "ekran geçiriyor, sunucu reddediyor" hâline döner.
 */
describe("havuz çıkışı 3. adımda zorunlu", () => {
  it("statü seçilmediyse adım gerçekten isteğe bağlı — İleri açık", async () => {
    const { fetchImpl } = stubFetch(baseRoutes());
    renderScreen(<SetupScreen />, { fetchImpl });
    await fillProject();
    await chooseFlow();
    await pickRepo();
    await fillTickets();
    await screen.findByText("Jira durumlarını da değiştirsin mi?");
    // Havuz yok → çıkış da gerekmiyor.
    expect(screen.getByRole("button", { name: "İleri" })).toBeEnabled();
  });
});
