import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocation } from "react-router";
import { describe, expect, it } from "vitest";
import { NotifyScreen } from "../src/screens/Notify.tsx";
import { RoutingScreen } from "../src/screens/Routing.tsx";
import { renderScreen, stubFetch, VIEWER } from "./harness.tsx";

/** Where the router is now — the screen navigates after an approval. */
function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

function routingBody(whenOnpremMissing: string, gizliOutcome: string) {
  return {
    path: "/routing",
    body: {
      projects: [
        // No `trigger` field and no `routing.note.active_*` label sentence
        // (0023): the wire stopped carrying the retired project-wide trigger,
        // so a fixture that still sent one would be testing a shape the BFF
        // no longer produces.
        {
          projectKey: "UGURPAY",
          apps: ["ugurpay-core"],
          noteKey: "routing.note.active_by_rule",
        },
      ],
      rules: [
        { ruleId: "dataclass:acik", conditionKey: "routing.policy.condition.data_class", conditionParams: { dataClass: "acik" }, backend: "api", model: "api", outcome: "ok" },
        { ruleId: "dataclass:dahili", conditionKey: "routing.policy.condition.data_class", conditionParams: { dataClass: "dahili" }, backend: "api", model: "api", outcome: "ok" },
        { ruleId: "dataclass:gizli", conditionKey: "routing.policy.condition.data_class", conditionParams: { dataClass: "gizli" }, backend: "onprem", model: "onprem", outcome: "ok" },
        { ruleId: "dataclass:onprem_missing", conditionKey: "routing.policy.condition.backend_unavailable", conditionParams: { backend: "onprem" }, backend: "onprem", model: "onprem", outcome: gizliOutcome },
      ],
      // The RAW stored policy — the only safe thing to edit against. The rules
      // above are lossy (`degraded` hides `degrade_ai_assist` vs `masked_cloud`).
      policy: {
        backendByClass: { acik: "api", dahili: "api", gizli: "onprem" },
        whenOnpremMissing,
      },
    },
  };
}

// Default fixture: a lenient degraded fallback.
const ROUTING_BODY = routingBody("degrade_ai_assist", "degraded");

const APPS_BODY = {
  path: "/studio/apps",
  body: {
    items: [
      {
        appId: "ugurpay-core",
        displayName: "UgurPay Core",
        adoProject: "Payments",
        adoRepo: "ugurpay-core",
        platform: "linux-node",
        jiraComponent: null,
        jiraProjectKey: "UGURPAY",
        maestroYamlPresent: true,
        createdVia: "onboarding",
      },
    ],
    nextCursor: null,
  },
};

/**
 * ── KAYIT DEFTERİ: SAHİPLİK VE ADRES ───────────────────────────────────────
 *
 * İki ayrı tutarsızlık sahada "proje bağlama tutarsız" olarak bildirildi:
 *
 *  1. Bir deponun HANGİ Jira projesine ait olduğu hiçbir yerde yazmıyordu —
 *     oysa `/routing`in proje→uygulama listesi tam olarak o kolona dayanıyor.
 *     Canlıda ölçüldü: `Uguryldz/maestro-pilot`ın değeri NULL (sahipsiz) ama
 *     bağlamanın varsayılanı o olduğu için OPS altında görünüyordu. Operatör
 *     deponun bağlı olduğunu sanıyordu.
 *  2. Aynı depo iki Studio ekranında İKİ FARKLI adresle yazıyordu: kayıt
 *     defteri `proje/depo`, Detay ekranı `proje/_git/depo`. ADO'da bir
 *     deponun gerçek adresi `_git` içerir; kopyalanan adres 404 verir.
 */
describe("routing screen — kayıt defteri", () => {
  it("names the OWNING project, and says so when a repository has none", async () => {
    const unowned = {
      path: "/studio/apps",
      body: {
        items: [
          { ...APPS_BODY.body.items[0]!, appId: "sahipsiz-depo", jiraProjectKey: null },
        ],
        nextCursor: null,
      },
    };
    const { fetchImpl } = stubFetch([ROUTING_BODY, unowned]);
    renderScreen(<RoutingScreen />, { fetchImpl });
    // Sahipsizlik SÖYLENİR: sessiz bir boşluk, operatöre "bağlı" diye okunuyordu.
    expect(await screen.findByText(/sahipsiz/u)).toBeInTheDocument();
  });

  /**
   * KURALLAR ADLARIYLA — "yeşil" tek şeyi ölçüyordu.
   *
   * Rozet yalnızca "bu projenin bir kuralı var mı" diye soruyordu. Yanlış veri
   * sınıfıyla, erişilemeyen bir depoyla ya da hiçbir ticket'ın taşımadığı bir
   * eşleşme değeriyle bağlanmış bir proje de YEŞİL görünüyordu — operatörün
   * "bağlı ama çalışmıyor" dediği durumun tam olarak kaynağı.
   */
  it("her projenin altında kurallarını ne yaptıklarıyla listeler", async () => {
    const rules = {
      path: "/studio/listening-rules",
      body: {
        rules: [
          {
            projectKey: "UGURPAY",
            flowType: "analiz",
            matchKind: "issuetype",
            matchValue: "Görev",
            enabled: true,
            repoMap: { entries: [{ appId: "Uguryldz/maestro-platform" }] },
          },
          {
            projectKey: "UGURPAY",
            flowType: "gelistirme",
            matchKind: "assigned",
            matchValue: "*",
            enabled: false,
            repoMap: null,
          },
        ],
      },
    };
    const { fetchImpl } = stubFetch([ROUTING_BODY, rules]);
    renderScreen(<RoutingScreen />, { fetchImpl });

    // Kaç kural olduğu — "var/yok" değil.
    expect(await screen.findByText(/2 kural/u)).toBeInTheDocument();
    // Kuralın NE YAPTIĞI ve HANGİ DEPOYA indiği.
    expect(await screen.findByText(/Görev.*Uguryldz\/maestro-platform/u)).toBeInTheDocument();
    // Kapalı kural kapalı olduğunu söyler — sessizce "yeşil"e karışmaz.
    expect(await screen.findByText(/kapalı/u)).toBeInTheDocument();
  });

  it("addresses an ADO repository the way ADO does — with _git", async () => {
    const { fetchImpl } = stubFetch([ROUTING_BODY, APPS_BODY]);
    renderScreen(<RoutingScreen />, { fetchImpl });
    // Detay ekranı (`RunSidebar`) bunu zaten böyle yazıyor; iki ekran ayrışmamalı.
    expect(await screen.findByText("Payments/_git/ugurpay-core")).toBeInTheDocument();
  });
});

describe("routing screen", () => {
  it("shows the Application Registry target of a match (M100)", async () => {
    const { fetchImpl } = stubFetch([ROUTING_BODY, APPS_BODY]);
    renderScreen(<RoutingScreen />, { fetchImpl });

    expect(await screen.findByText("UgurPay Core")).toBeInTheDocument();
    /*
      ADO hedefi, ADO'nun kendi ADRESLEME biçimiyle: `proje/_git/depo`.
      Burası bir dönem `proje/depo` bekliyordu ve ekran da öyle basıyordu —
      ama Detay ekranı (`RunSidebar`) aynı depoyu `_git` ile yazıyordu. İki
      Studio ekranı aynı depoyu iki farklı adresle gösteriyordu ve kayıt
      defterinden kopyalanan adres ADO'da 404 veriyordu.
    */
    expect(screen.getByText("Payments/_git/ugurpay-core")).toBeInTheDocument();
  });

  it("hides the guarded policy editor from a non-admin", async () => {
    const { fetchImpl } = stubFetch([ROUTING_BODY, APPS_BODY]);
    renderScreen(<RoutingScreen />, { fetchImpl, session: VIEWER });

    await screen.findByText("UgurPay Core");
    expect(screen.queryByRole("button", { name: /Politikayı düzenle/ })).not.toBeInTheDocument();
  });

  it("saves the data-class policy as a four-eyes proposal, not a live change", async () => {
    const { fetchImpl, calls } = stubFetch([
      ROUTING_BODY,
      APPS_BODY,
      {
        path: "/routing",
        method: "PUT",
        body: { status: "pending", pending: { key: "dataclass.policy", scopeRef: null, value: {}, proposedBy: "someone.else", at: "2026-08-10T00:00:00.000Z" } },
      },
    ]);
    renderScreen(<RoutingScreen />, { fetchImpl });

    await screen.findByText("UgurPay Core");
    await userEvent.click(screen.getByRole("button", { name: /Politikayı düzenle/ }));
    // The guarded warning is shown before the operator types.
    expect(await screen.findByText(/korumalıdır/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Onaya gönder/ }));

    const put = calls.find((call) => call.method === "PUT" && call.url.endsWith("/routing"));
    expect(put).toBeDefined();
    const payload = put!.body as { policy: { backendByClass: Record<string, string> } };
    // Backends are prefilled from the raw stored policy.
    expect(payload.policy.backendByClass.gizli).toBe("onprem");
    // A guarded save reports pending, never "applied".
    expect(await screen.findByText(/dört-göz onayına gönderildi/)).toBeInTheDocument();
  });

  /**
   * The security regression the verifier caught: a no-op save must NOT downgrade
   * the stored fallback. With `whenOnpremMissing: "block"` in the database, an
   * admin who opens the editor (to change something else, or nothing) and never
   * touches the fallback dropdown must PUT `block` back — not the lenient
   * `degrade_ai_assist` the screen once hardcoded, which would silently let a
   * `gizli` ticket that should be BLOCKED fall through to AI-assist, past two
   * approvers who only ever saw the fabricated value.
   */
  it("round-trips the stored fallback verbatim on an untouched save (no silent downgrade)", async () => {
    const { fetchImpl, calls } = stubFetch([
      routingBody("block", "blocked"),
      APPS_BODY,
      {
        path: "/routing",
        method: "PUT",
        body: { status: "applied", change: {} },
      },
    ]);
    renderScreen(<RoutingScreen />, { fetchImpl });

    await screen.findByText("UgurPay Core");
    await userEvent.click(screen.getByRole("button", { name: /Politikayı düzenle/ }));
    await screen.findByText(/korumalıdır/);
    // Deliberately touch NOTHING, then save.
    await userEvent.click(screen.getByRole("button", { name: /Onaya gönder/ }));

    const put = calls.find((call) => call.method === "PUT" && call.url.endsWith("/routing"));
    expect(put).toBeDefined();
    const payload = put!.body as { policy: { whenOnpremMissing: string } };
    expect(payload.policy.whenOnpremMissing).toBe("block");
    expect(payload.policy.whenOnpremMissing).not.toBe("degrade_ai_assist");
  });

  // The onboarding approval queue (M93): a submitted package is now visible here
  // and an admin can approve it, which is the step that turns a proposal into a
  // live binding. Before this the queue had no reader at all.
  const PENDING_BODY = {
    path: "/onboarding/pending",
    body: {
      items: [
        {
          projectKey: "OPS",
          appId: "Uguryldz/maestro-pilot",
          adoRepo: "Uguryldz/maestro-pilot",
          platform: "linux-node",
          triggerMode: "opt_in",
          gateSet: "risk_tiered",
          mergeMode: "human",
          proposedBy: "ayse.kaya@ugurbank.local",
          at: "2026-08-13T10:00:00.000Z",
        },
      ],
    },
  };

  it("shows a submitted onboarding package and approves it into a binding", async () => {
    const { fetchImpl, calls } = stubFetch([
      ROUTING_BODY,
      APPS_BODY,
      PENDING_BODY,
      { path: "/onboarding/approve", method: "POST", body: { status: "bound", projectKey: "OPS", nextStep: "listening_rule" } },
    ]);
    renderScreen(
      <>
        <RoutingScreen />
        <LocationProbe />
      </>,
      { fetchImpl },
    );

    // The package is listed with its repo and proposer.
    expect(await screen.findByText("Uguryldz/maestro-pilot")).toBeInTheDocument();
    expect(screen.getByText("ayse.kaya@ugurbank.local")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Onayla" }));

    const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/onboarding/approve"));
    expect(post).toBeDefined();
    expect((post!.body as { projectKey: string }).projectKey).toBe("OPS");
    // After approval the operator is TAKEN to the chain's next step — the
    // listening rules of the project that just went live — rather than pointed
    // at a button inside the queue card that vanishes with the last package.
    await screen.findByText(/OPS bağlandı/);
    expect(screen.getByTestId("location")).toHaveTextContent(
      "/projects?tab=listening&projectKey=OPS",
    );
  });

  it("warns — with the reason — when the approval bound the project but the default rules could not be seeded", async () => {
    // The fail-soft seed: `listeningSeed: null` used to render as the same
    // cheerful "bağlandı" while zero tickets were listened to. The response now
    // names why (`seedSkipped.reason`) and the screen must say it out loud.
    const { fetchImpl } = stubFetch([
      ROUTING_BODY,
      APPS_BODY,
      PENDING_BODY,
      {
        path: "/onboarding/approve",
        method: "POST",
        body: {
          status: "bound",
          projectKey: "OPS",
          nextStep: "listening_rule",
          listeningSeed: null,
          seedSkipped: { reason: "issue_types_unavailable" },
        },
      },
    ]);
    renderScreen(<RoutingScreen />, { fetchImpl });

    await screen.findByText("Uguryldz/maestro-pilot");
    await userEvent.click(screen.getByRole("button", { name: "Onayla" }));

    // The warning names the project, the reason and the way out.
    expect(
      await screen.findByText(/varsayılan dinleme kuralları kurulamadı/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Jira iş türü listesi okunamadı/)).toBeInTheDocument();
    // Never the celebratory "otomatik kuruldu" line for a seed that did not run.
    expect(screen.queryByText(/otomatik kuruldu/)).not.toBeInTheDocument();
  });

  it("says where a repo-less package's repository comes from instead of showing an empty cell", async () => {
    // The BFF sends explicit nulls for a proposal that binds no repository —
    // the normal case now: a binding binds a Jira project, and the repo comes
    // from the listening rule's repo map. The cell must SAY that; a blank would
    // read as data loss on the one screen where the second human decides, and
    // the old line ("yalnızca analiz, belge ticket metninden") named a chain
    // that no longer exists.
    const noRepoPending = {
      path: "/onboarding/pending",
      body: {
        items: [
          {
            ...PENDING_BODY.body.items[0],
            appId: null,
            adoRepo: null,
            platform: null,
          },
        ],
      },
    };
    const { fetchImpl } = stubFetch([ROUTING_BODY, APPS_BODY, noRepoPending]);
    renderScreen(<RoutingScreen />, { fetchImpl });

    expect(
      await screen.findByText("depo yok — depo dinleme kuralının eşlemesinden gelir"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/yalnızca analiz/)).toBeNull();
  });

  it("names both who may approve: a second admin OR the principal approver", async () => {
    // A single-admin install: the principal approver confirms alone. The queue
    // used to say "ikinci bir yönetici onaylar" flat out, which told that admin
    // the button in front of them would not work.
    const { fetchImpl } = stubFetch([ROUTING_BODY, APPS_BODY, PENDING_BODY]);
    renderScreen(<RoutingScreen />, { fetchImpl });

    await screen.findByText("Uguryldz/maestro-pilot");
    expect(screen.getByText(/onay: ikinci yönetici ya da ana onaylayıcı/)).toBeInTheDocument();
    expect(screen.queryByText(/Uygulama ekle'den gelen/)).toBeNull();
  });

  it("hides the approval queue from a non-admin", async () => {
    const { fetchImpl } = stubFetch([ROUTING_BODY, APPS_BODY, PENDING_BODY]);
    renderScreen(<RoutingScreen />, { fetchImpl, session: VIEWER });

    await screen.findByText("UgurPay Core");
    // A viewer never sees an approve button.
    expect(screen.queryByRole("button", { name: "Onayla" })).not.toBeInTheDocument();
  });

  /**
   * "Düzenle" on a bound project — the affordance the list never had.
   *
   * The bound-projects table was read-only: once a project was bound there was
   * no way to change anything about it from the UI, and no way to find out why.
   * What it can honestly become is bounded by the API, which was measured:
   * `POST /onboarding` is a CREATE path that refuses an already-bound project
   * (`project_already_bound`), and there is no update endpoint at all. So the
   * one thing this must NOT do is offer a save button that files nothing — on a
   * four-eyes decision about which repository an agent may push to, a silent
   * no-op is the worst possible outcome. These tests pin both halves: the
   * editable path is wired, and the gap is named rather than faked.
   */
  describe("editing a bound project", () => {
    it("offers Düzenle on each bound project, to an admin only", async () => {
      const { fetchImpl } = stubFetch([ROUTING_BODY, APPS_BODY]);
      renderScreen(<RoutingScreen />, { fetchImpl });
      await screen.findByText("UgurPay Core");
      expect(screen.getByRole("button", { name: "Düzenle" })).toBeInTheDocument();
    });

    it("does not offer it to a non-admin", async () => {
      const { fetchImpl } = stubFetch([ROUTING_BODY, APPS_BODY]);
      renderScreen(<RoutingScreen />, { fetchImpl, session: VIEWER });
      await screen.findByText("UgurPay Core");
      expect(screen.queryByRole("button", { name: "Düzenle" })).not.toBeInTheDocument();
    });

    /**
     * ── PANEL ARTIK GERÇEK BİR FORM ────────────────────────────────────────
     *
     * Burası bir dönem form DEĞİLDİ ve iki test bunu tutuyordu: "kilitli
     * alanlar" metni ve "hiçbir istek yapmaz". Gerekçe o gün doğruydu —
     * güncelleme ucu YOKTU, bir "Kaydet" hiçbir şey dosyalamayıp başarı
     * bildirirdi.
     *
     * Sahada bu "UI'da yetersiz" diye bildirildi: tetikleme kipi, yayınlama
     * kipi, veri sınıfı ve durum bir kez yazıldıktan sonra değiştirilemiyordu;
     * tek çare projeyi çözüp yeniden onboard etmek ve İKİNCİ bir onaydan
     * geçmekti. `PATCH /onboarding/:projectKey` eklendi ve panel ona yazıyor.
     */
    it("saves ONLY the fields the operator actually changed", async () => {
      const { fetchImpl, calls } = stubFetch([
        ROUTING_BODY,
        APPS_BODY,
        { path: "/onboarding/UGURPAY", method: "PATCH", body: null, status: 204 },
      ]);
      renderScreen(<RoutingScreen />, { fetchImpl });
      await screen.findByText("UgurPay Core");

      await userEvent.click(screen.getByRole("button", { name: "Düzenle" }));
      expect(await screen.findByText("UGURPAY bağlamasını düzenle")).toBeInTheDocument();

      // Kutular "değiştirme" ile açılır: `/routing` mevcut değerleri
      // GÖNDERMİYOR ve uydurma bir varsayılan, dokunulmayan alanı ezerdi.
      await userEvent.selectOptions(screen.getByLabelText("Veri sınıfı"), "gizli");
      await userEvent.click(screen.getByRole("button", { name: "Kaydet" }));

      await waitFor(() => {
        const patch = calls.find((c) => c.method === "PATCH");
        expect(patch, "PATCH gönderilmedi").toBeTruthy();
        expect(patch!.url).toContain("/onboarding/UGURPAY");
        // Yalnız DEĞİŞEN alan: hepsini göndermek, eş zamanlı bir düzenlemeyi
        // sessizce geri alırdı.
        expect(patch!.body).toEqual({ defaults: { dataClass: "gizli" } });
      });
    });

    it("still offers the listening rules — the other half of the answer", async () => {
      const { fetchImpl } = stubFetch([ROUTING_BODY, APPS_BODY]);
      renderScreen(<RoutingScreen />, { fetchImpl });
      await screen.findByText("UgurPay Core");

      await userEvent.click(screen.getByRole("button", { name: "Düzenle" }));
      await screen.findByText("UGURPAY bağlamasını düzenle");
      // "Hangi ticket'lar alınır" hâlâ dinleme kurallarının işi; panel oraya
      // tek tıkla götürmeye devam ediyor.
      expect(screen.getByRole("button", { name: "Dinleme kurallarını aç" })).toBeInTheDocument();
    });

    /**
     * ── KUTULAR MEVCUT DEĞERLE AÇILIR ─────────────────────────────────────
     *
     * `/routing` bağlamanın bugünkü ayarlarını (`binding`) göndermeye başladı;
     * panel artık boş bir form değil. İki ilke korunur: dokunulmayan kutu
     * tele çıkmaz, ve eski bir BFF (alan yok) eski davranışı görür — yukarıdaki
     * test tam olarak o hâli tutuyor.
     */
    it("opens PRE-FILLED with the binding's current settings and sends only what changed", async () => {
      const body = ROUTING_BODY.body;
      const { fetchImpl, calls } = stubFetch([
        {
          path: "/routing",
          body: {
            ...body,
            projects: [
              {
                ...body.projects[0],
                binding: { trigger: "label", state: "active", mode: "human_lead", dataClass: "dahili" },
              },
            ],
          },
        },
        APPS_BODY,
        { path: "/onboarding/UGURPAY", method: "PATCH", body: null, status: 204 },
      ]);
      renderScreen(<RoutingScreen />, { fetchImpl });
      await screen.findByText("UgurPay Core");

      await userEvent.click(screen.getByRole("button", { name: "Düzenle" }));
      await screen.findByText("UGURPAY bağlamasını düzenle");

      // Every box shows today's value — and the "leave unchanged" row is gone,
      // because there is nothing unknown to leave.
      expect((screen.getByLabelText("Tetikleme") as HTMLSelectElement).value).toBe("label");
      expect((screen.getByLabelText("Veri sınıfı") as HTMLSelectElement).value).toBe("dahili");
      expect((screen.getByLabelText("Durum") as HTMLSelectElement).value).toBe("active");
      expect((screen.getByLabelText("Yayınlama modu") as HTMLSelectElement).value).toBe("human_lead");
      expect(screen.queryByRole("option", { name: "— değiştirme —" })).not.toBeInTheDocument();

      await userEvent.selectOptions(screen.getByLabelText("Durum"), "paused");
      await userEvent.click(screen.getByRole("button", { name: "Kaydet" }));

      await waitFor(() => {
        const patch = calls.find((c) => c.method === "PATCH");
        expect(patch, "PATCH gönderilmedi").toBeTruthy();
        // The three untouched boxes hold real values now, and STILL stay off
        // the wire: pre-filling must not turn every save into a full rewrite.
        expect(patch!.body).toEqual({ state: "paused" });
      });
    });

    it("writes nothing until the operator presses save — opening is not a change", async () => {
      const { fetchImpl, calls } = stubFetch([ROUTING_BODY, APPS_BODY]);
      renderScreen(<RoutingScreen />, { fetchImpl });
      await screen.findByText("UgurPay Core");

      await userEvent.click(screen.getByRole("button", { name: "Düzenle" }));
      await screen.findByText("UGURPAY bağlamasını düzenle");

      // Bağlama dört-göz yönetilen bir karar; paneli AÇMAK bir değişiklik
      // değildir ve sessizce hiçbir şey dosyalanmamalıdır.
      expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
    });
  });
});

const NOTIFY_BODY = {
  path: "/notify",
  body: {
    ladder: [{ afterHours: 24, channels: ["jira"], kind: "notify" }],
    delegations: [],
    waiting: [],
    routing: { default: ["teams"], byEvent: {} },
    ladderRaw: {
      steps: [{ id: "reminder-24h", afterHours: 24, channel: "jira", event: "gate_reminder", action: "notify" }],
      businessHoursOnly: false,
      calendar: {},
    },
    teamsWebhookMask: "",
  },
};

describe("notify screen — master switch", () => {
  it("shows the switch on by default and PUTs enabled:false when unticked", async () => {
    const { fetchImpl, calls } = stubFetch([
      NOTIFY_BODY,
      { path: "/notify", method: "PUT", body: { results: [{ status: "applied", change: {} }] } },
    ]);
    renderScreen(<NotifyScreen />, { fetchImpl });

    const box = await screen.findByRole("checkbox", { name: "Bildirimleri gönder" });
    expect(box).toBeChecked();
    await userEvent.click(box);

    const put = calls.find((call) => call.method === "PUT" && call.url.endsWith("/notify"));
    expect(put).toBeDefined();
    expect(put!.body).toEqual({ enabled: false });
  });
});

describe("notify screen editing", () => {
  it("edits a threshold and PUTs the same step id so open gates do not re-escalate", async () => {
    const { fetchImpl, calls } = stubFetch([
      NOTIFY_BODY,
      { path: "/notify", method: "PUT", body: { results: [{ status: "applied", change: {} }] } },
    ]);
    renderScreen(<NotifyScreen />, { fetchImpl });

    await userEvent.click(await screen.findByRole("button", { name: /Merdiveni düzenle/ }));
    const dialog = await screen.findByRole("dialog");
    const hours = within(dialog).getByRole("spinbutton");
    await userEvent.clear(hours);
    await userEvent.type(hours, "48");
    await userEvent.click(within(dialog).getByRole("button", { name: "Kaydet" }));

    const put = calls.find((call) => call.method === "PUT" && call.url.endsWith("/notify"));
    expect(put).toBeDefined();
    const payload = put!.body as { ladder: { steps: { id: string; afterHours: number }[] } };
    expect(payload.ladder.steps[0]?.id).toBe("reminder-24h");
    expect(payload.ladder.steps[0]?.afterHours).toBe(48);
  });

  // Delivery honesty comes from the runtime now: `GET /notify` carries the
  // deployment's `drivers`, and the screen marks each routed channel live or
  // not from that — never a blanket "not live yet" typed into the client, and
  // never a green badge for a channel nobody wired.
  it("says it cannot tell whether channels deliver when the BFF sent no drivers", async () => {
    const { fetchImpl } = stubFetch([NOTIFY_BODY]);
    renderScreen(<NotifyScreen />, { fetchImpl });
    expect(
      await screen.findByText(/Kanalların bağlı olup olmadığı henüz okunamadı/),
    ).toBeInTheDocument();
    // No channel is claimed dead — or live — on a guess.
    expect(screen.queryByText(/pasif/)).not.toBeInTheDocument();
  });

  it("marks a routed channel the runtime cannot deliver to as pasif, so nobody waits for it", async () => {
    const { fetchImpl } = stubFetch([
      {
        path: "/notify",
        body: {
          ...NOTIFY_BODY.body,
          drivers: [
            { channel: "teams", enabled: false, target: "TEAMS_WEBHOOK_URL" },
            { channel: "jira", enabled: true, target: "jira" },
          ],
        },
      },
    ]);
    renderScreen(<NotifyScreen />, { fetchImpl });
    // Every event routes to `teams` by default, and teams is not wired here.
    const dead = await screen.findAllByText(/Teams · pasif/);
    expect(dead.length).toBeGreaterThan(0);
    expect(screen.getByText(/'pasif' kanallar tanımlı ama runtime'a bağlı değil/)).toBeInTheDocument();
  });

  it("keeps the edit button from a non-admin", async () => {
    const { fetchImpl } = stubFetch([NOTIFY_BODY]);
    renderScreen(<NotifyScreen />, { fetchImpl, session: VIEWER });

    await screen.findByText(/otomatik reddedilmez/);
    expect(screen.queryByRole("button", { name: /Merdiveni düzenle/ })).not.toBeInTheDocument();
    // A non-admin also gets no routing-edit button.
    expect(screen.queryByRole("button", { name: /Eşlemeyi düzenle/ })).not.toBeInTheDocument();
  });

  it("saves a Teams webhook URL through PUT /notify (never prefilled)", async () => {
    const { fetchImpl, calls } = stubFetch([
      NOTIFY_BODY,
      { path: "/notify", method: "PUT", body: { results: [{ status: "applied", change: {} }] } },
    ]);
    renderScreen(<NotifyScreen />, { fetchImpl });

    const field = await screen.findByLabelText("Teams webhook URL");
    await userEvent.type(field, "https://outlook.office.com/webhook/abc123");
    await userEvent.click(screen.getByRole("button", { name: "Kaydet" }));

    const put = calls.find((call) => call.method === "PUT" && call.url.endsWith("/notify"));
    expect(put).toBeDefined();
    expect((put!.body as { teamsWebhook?: string }).teamsWebhook).toBe(
      "https://outlook.office.com/webhook/abc123",
    );
  });

  it("shows the event→channel routing: each event with its channels, defaults marked", async () => {
    const { fetchImpl } = stubFetch([
      {
        path: "/notify",
        body: {
          ...NOTIFY_BODY.body,
          // gate_open explicitly on jira; kill_switch muted; everything else default (teams).
          routing: { default: ["teams"], byEvent: { gate_open: ["jira"], kill_switch: [] } },
        },
      },
    ]);
    renderScreen(<NotifyScreen />, { fetchImpl });

    // The routing card lists every event by its localized name.
    expect(await screen.findByText("Onay kapısı açıldı")).toBeInTheDocument();
    expect(screen.getByText("Kill-switch")).toBeInTheDocument();
    // A muted event is shown as such, not blank.
    expect(screen.getByText("susturulmuş")).toBeInTheDocument();
    // An event with no explicit rule is marked as following the default.
    expect(screen.getAllByText(/varsayılan/).length).toBeGreaterThan(0);
  });
});
