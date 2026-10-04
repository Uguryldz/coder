import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { HealthScreen } from "../src/screens/Health.tsx";
import { NotifyScreen } from "../src/screens/Notify.tsx";
import { ReposScreen } from "../src/screens/Onboard.tsx";
import { SandboxScreen } from "../src/screens/Sandbox.tsx";
import { YamlScreen } from "../src/screens/Yaml.tsx";
import { ADMIN, renderScreen, stubFetch } from "./harness.tsx";

describe("sandbox screen", () => {
  it("shows an empty state rather than inventing a session", async () => {
    const { fetchImpl } = stubFetch([
      { path: "/studio/sandboxes", body: { items: [], nextCursor: null } },
    ]);
    renderScreen(<SandboxScreen />, { fetchImpl });

    expect(await screen.findByText("Açık sandbox oturumu yok")).toBeInTheDocument();
  });

  it("renders a workspace a human is holding as its own state, and offers no delete", async () => {
    const { fetchImpl } = stubFetch([
      {
        path: "/studio/sandboxes",
        body: {
          items: [
            {
              ticketKey: "UGURPAY-503",
              runnerId: "lnx-02",
              state: "human_held",
              sizeBytes: 2_306_867,
              lastAccessAt: "2026-08-08T11:00:00.000Z",
            },
          ],
          nextCursor: null,
        },
      },
    ]);
    renderScreen(<SandboxScreen />, { fetchImpl });

    expect(await screen.findByText("UGURPAY-503")).toBeInTheDocument();
    expect(screen.getByText("insan çalışıyor")).toBeInTheDocument();
    // A delete control here is how somebody destroys the session a human is
    // mid-way through; the retention job owns removal (M65).
    expect(screen.queryByRole("button", { name: /[Ss]il/ })).not.toBeInTheDocument();
  });

  it("never renders a session transcript, and says why", async () => {
    const { fetchImpl } = stubFetch([
      { path: "/studio/sandboxes", body: { items: [], nextCursor: null } },
    ]);
    renderScreen(<SandboxScreen />, { fetchImpl });

    expect(await screen.findByText(/maskelenmemiş ticket metni/)).toBeInTheDocument();
  });
});
describe("yaml screen", () => {
  const POLICY = {
    appId: "ugurpay",
    platform: "linux-node",
    repo: "Odeme/_git/ugurpay",
    yaml: "platform: linux-node\ncommands:\n  build: npm run build",
    protectedPaths: {
      platformDefaults: ["prisma/migrations/**", ".env*"],
      repoAdditions: ["src/payment-core/**"],
    },
    fetchedAt: "2026-08-08T12:00:00.000Z",
  };

  it("lists platform defaults read-only and offers removal only for repo additions", async () => {
    const { fetchImpl } = stubFetch([{ path: "/repo-policy", body: { policies: [POLICY] } }]);
    renderScreen(<YamlScreen />, { fetchImpl });

    expect(await screen.findByText("prisma/migrations/**")).toBeInTheDocument();
    expect(screen.getByText("kaldırılamaz")).toBeInTheDocument();

    // Exactly one remove control: the repo addition. A default must offer none.
    const removeButtons = screen.getAllByRole("button", { name: "Kaldır" });
    expect(removeButtons).toHaveLength(1);
    expect(screen.getByText("src/payment-core/**")).toBeInTheDocument();
  });

  it("only ever adds a protected path, never deletes a default", async () => {
    const { fetchImpl, calls } = stubFetch([
      { path: "/repo-policy", body: { policies: [POLICY] } },
      { path: "/protected-paths", method: "POST", body: POLICY },
    ]);
    renderScreen(<YamlScreen />, { fetchImpl });

    await userEvent.type(await screen.findByLabelText("Yeni korumalı yol"), "keystore/**");
    await userEvent.click(screen.getByRole("button", { name: "Ekle" }));

    await waitFor(() => {
      const post = calls.find((call) => call.method === "POST");
      expect(post?.body).toEqual({ path: "keystore/**" });
    });
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  it("refuses to send an empty path", async () => {
    const { fetchImpl, calls } = stubFetch([
      { path: "/repo-policy", body: { policies: [POLICY] } },
    ]);
    renderScreen(<YamlScreen />, { fetchImpl });

    await userEvent.click(await screen.findByRole("button", { name: "Ekle" }));
    expect(await screen.findByText("Yol boş olamaz.")).toBeInTheDocument();
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });
});

describe("health screen", () => {
  const SERVICE = {
    service: "postgres",
    state: "healthy",
    version: "16.4",
    checkedAt: "2026-08-08T12:00:00.000Z",
    note: null,
  };

  it("renders the overall state the server decided, not one recomputed here", async () => {
    const { fetchImpl } = stubFetch([
      {
        path: "/studio/health",
        body: {
          state: "degraded",
          services: [SERVICE, { ...SERVICE, service: "redis", state: "degraded" }],
        },
      },
    ]);
    renderScreen(<HealthScreen />, { fetchImpl });

    expect(await screen.findByText("Bazı servisler sorunlu")).toBeInTheDocument();
  });

  it("shows an unknown service by its id instead of blanking the page", async () => {
    const { fetchImpl } = stubFetch([
      {
        path: "/studio/health",
        body: {
          state: "down",
          services: [SERVICE, { ...SERVICE, service: "brand_new_thing", state: "down" }],
        },
      },
    ]);
    renderScreen(<HealthScreen />, { fetchImpl });

    // The catalogued one still renders...
    expect(await screen.findByText("PostgreSQL")).toBeInTheDocument();
    // ...and the uncatalogued one appears rather than throwing behind the
    // error boundary and taking the whole page with it.
    expect(screen.getByText("brand_new_thing")).toBeInTheDocument();
  });

  it("an unconfigured LLM says so honestly and points at the settings screen", async () => {
    // "Not set up" must be its own state — not a fake green and not a red that
    // pages somebody — and the row must say WHERE to fix it, by the name the
    // navigation gives that screen (`nav.settings` = Bağlantılar).
    const { fetchImpl } = stubFetch([
      {
        path: "/studio/health",
        body: {
          state: "healthy",
          services: [
            SERVICE,
            {
              service: "llm",
              state: "not_configured",
              version: "llm",
              checkedAt: SERVICE.checkedAt,
              note: "health.note.not_configured",
            },
          ],
        },
      },
    ]);
    renderScreen(<HealthScreen />, { fetchImpl });

    expect(await screen.findByText("Model sağlayıcı (LLM)")).toBeInTheDocument();
    expect(screen.getByText("yapılandırılmadı")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Bağlantılar'a git" });
    expect(link).toHaveAttribute("href", "/settings");
    // An unconfigured connector is a to-do, not an outage — the platform badge
    // the server computed stays green beside it.
    expect(screen.getByText("Tüm servisler sağlıklı")).toBeInTheDocument();
  });

  it("a failing Jira credential reads kapalı, with the fix link beside the reason", async () => {
    const { fetchImpl } = stubFetch([
      {
        path: "/studio/health",
        body: {
          state: "down",
          services: [
            {
              service: "jira",
              state: "down",
              version: "jira_cloud",
              checkedAt: SERVICE.checkedAt,
              note: "connections.test.no_token",
            },
          ],
        },
      },
    ]);
    renderScreen(<HealthScreen />, { fetchImpl });

    expect(await screen.findByText("kapalı")).toBeInTheDocument();
    // The stored test verdict travels as a catalog key and renders as a sentence.
    expect(screen.getByText(/Token tanımlı değil/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Bağlantılar'a git" })).toHaveAttribute(
      "href",
      "/settings",
    );
  });
});

/**
 * Yapılandırma bölümü — operatörün istediği tek cümlenin ekrandaki hâli:
 * "DC ise DC göreyim orada".
 *
 * NOT: `stubFetch` yolu `endsWith` ile eşliyor, yani `/studio/config-health`
 * `/studio/health` ile de biten bir yol. Bu yüzden dar olan HER ZAMAN önce
 * yazılıyor — sıra bozulursa yapılandırma sorgusu servis yanıtını alır.
 */
describe("health screen — yapılandırma", () => {
  const SERVICES = {
    state: "healthy",
    services: [
      {
        service: "postgres",
        state: "healthy",
        version: "16.4",
        checkedAt: "2026-08-08T12:00:00.000Z",
        note: null,
      },
    ],
  };

  function withConfig(body: unknown) {
    return stubFetch([
      { path: "/studio/config-health", body },
      { path: "/studio/health", body: SERVICES },
    ]);
  }

  it("says WHICH Jira in words, and names the variable that chose it", async () => {
    const { fetchImpl } = withConfig({
      state: "iyi",
      findings: [
        {
          id: "jira_driver",
          severity: "iyi",
          value: "jira-dc",
          detailKey: "config.detail.jira_driver.chosen",
          detailParams: { variable: "JIRA_BASE_URL" },
          fixKey: null,
        },
      ],
    });
    renderScreen(<HealthScreen />, { fetchImpl });

    expect(await screen.findByText("Jira sürücüsü")).toBeInTheDocument();
    expect(screen.getByText("Jira Data Center")).toBeInTheDocument();
    expect(screen.getByText(/JIRA_BASE_URL dolu olduğu için/)).toBeInTheDocument();
    // Servis canlılığı bölümü olduğu gibi duruyor.
    expect(await screen.findByText("PostgreSQL")).toBeInTheDocument();
  });

  it("shows the fix beside a problem row and nothing beside a green one", async () => {
    const { fetchImpl } = withConfig({
      state: "sorun",
      findings: [
        {
          id: "jira_driver",
          severity: "sorun",
          value: "yapilandirilmamis",
          detailKey: "config.detail.jira_driver.none",
          fixKey: "config.fix.jira_driver.none",
        },
        {
          id: "webhook",
          severity: "bilgi",
          value: "tanimsiz",
          detailKey: "config.detail.webhook.absent",
          fixKey: "config.fix.webhook.absent",
        },
      ],
    });
    renderScreen(<HealthScreen />, { fetchImpl });

    expect(await screen.findByText("YAPILANDIRILMAMIŞ")).toBeInTheDocument();
    expect(screen.getByText(/YALNIZCA BİRİNİ doldurup/)).toBeInTheDocument();
    // DC'de webhook'suzluk bir hata gibi görünmüyor: "bilgi" rozeti.
    expect(screen.getByText("bilgi")).toBeInTheDocument();
    expect(screen.getByText("Yapılandırmada sorun var")).toBeInTheDocument();
  });

  it("keeps the server's order — problems stay at the top", async () => {
    const { fetchImpl } = withConfig({
      state: "sorun",
      findings: [
        { id: "clarify", severity: "sorun", value: "KAPALI", detailKey: null, fixKey: null },
        { id: "sweep", severity: "iyi", value: "acik", detailKey: null, fixKey: null },
      ],
    });
    renderScreen(<HealthScreen />, { fetchImpl });

    await screen.findByText("Netleştirme dönüşü");
    const names = screen.getAllByRole("row").map((r) => r.textContent ?? "");
    const clarify = names.findIndex((text) => text.includes("Netleştirme dönüşü"));
    const sweep = names.findIndex((text) => text.includes("Ticket taraması"));
    expect(clarify).toBeLessThan(sweep);
  });

  it("a config row the catalog has never heard of appears instead of blanking the page", async () => {
    const { fetchImpl } = withConfig({
      state: "uyari",
      findings: [
        { id: "yepyeni_sey", severity: "uyari", value: "garip", detailKey: null, fixKey: null },
      ],
    });
    renderScreen(<HealthScreen />, { fetchImpl });

    expect(await screen.findByText("yepyeni_sey")).toBeInTheDocument();
    expect(screen.getByText("garip")).toBeInTheDocument();
  });

  /**
   * İndirme butonu ve YANINDAKİ eksiklik cümlesi.
   *
   * Cümle testin konusu, süsü değil: panelden inen rapor servis log'larını
   * içermiyor, ve operatörün bunu butona basmadan ÖNCE okuması gerekiyor.
   * Yarım rapora bakıp "sorun yok" demek, bu ekranın kapatmaya geldiği
   * sessiz-yanlışın ta kendisi.
   */
  it("offers the report download and says, beside it, what the report is missing", async () => {
    const { fetchImpl } = withConfig({
      state: "iyi",
      findings: [{ id: "sweep", severity: "iyi", value: "acik", detailKey: null, fixKey: null }],
    });
    renderScreen(<HealthScreen />, { fetchImpl });

    expect(
      await screen.findByRole("button", { name: "Tanı raporu indir (.html)" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/SERVİS LOG'LARINI İÇERMEZ/)).toBeInTheDocument();
    expect(screen.getByText(/\.\/tani\.sh/)).toBeInTheDocument();
  });

  it("hides the download from a tech-lead who may still read the table", async () => {
    const { fetchImpl } = withConfig({
      state: "iyi",
      findings: [{ id: "sweep", severity: "iyi", value: "acik", detailKey: null, fixKey: null }],
    });
    renderScreen(<HealthScreen />, {
      fetchImpl,
      session: { ...ADMIN, roles: ["tech-lead"] },
    });

    // Tablo görünüyor…
    expect(await screen.findByText("Ticket taraması")).toBeInTheDocument();
    // …ama rapor düğmesi ve onun uyarısı yok. Asıl kapı sunucuda (403).
    expect(screen.queryByRole("button", { name: /Tanı raporu indir/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/SERVİS LOG'LARINI İÇERMEZ/)).not.toBeInTheDocument();
  });

  it("a failing config query does NOT take the service table down with it", async () => {
    const { fetchImpl } = stubFetch([
      { path: "/studio/config-health", body: { error: "boom" }, status: 500 },
      { path: "/studio/health", body: SERVICES },
    ]);
    renderScreen(<HealthScreen />, { fetchImpl });

    // Teşhis eklentisinin, teşhis etmeye geldiği ekranı karartması olacak en
    // kötü şeydir — servisler hâlâ okunabilir.
    expect(await screen.findByText("PostgreSQL")).toBeInTheDocument();
  });
});

describe("notify screen", () => {
  it("says no rung of the ladder auto-rejects", async () => {
    const { fetchImpl } = stubFetch([
      {
        path: "/notify",
        body: {
          ladder: [{ afterHours: 24, channels: ["jira"], kind: "notify" }],
          delegations: [],
          waiting: [
            {
              ticketKey: "UGURPAY-504",
              step: "analysis",
              waitingHours: 386,
              lastActionKey: null,
            },
          ],
          routing: { default: ["teams"], byEvent: {} },
          ladderRaw: {
            steps: [
              { id: "reminder-24h", afterHours: 24, channel: "jira", event: "gate_reminder", action: "notify" },
            ],
            businessHoursOnly: false,
            calendar: {},
          },
        },
      },
    ]);
    renderScreen(<NotifyScreen />, { fetchImpl });

    expect(await screen.findByText(/otomatik reddedilmez/)).toBeInTheDocument();
    // 386 hours is 16 days 2 hours — formatted through the catalog, not concatenated.
    expect(screen.getByText("16 gün 2 saat")).toBeInTheDocument();
  });
});

/**
 * "Depolar" — the repositories registered under bound projects, and the
 * "+ Depo ekle" form. This file used to be the EXPERT onboarding form (Jira
 * connection + project + repo + gate set + merge mode + dry run + "send for
 * admin approval"), which re-did the wizard's job and contradicted it. A
 * binding binds a Jira project (the wizard does that); a repository is
 * inventory the listening rule's repo map picks from, filed with
 * `POST /onboarding/apps` — no proposal, no dry run, no second approval.
 */
describe("repos tab (Depolar)", () => {
  const OPTIONS = {
    path: "/onboarding/options",
    body: { jiraProjects: ["OPS"], adoRepos: [], platforms: ["linux-node"] },
  };
  const ROUTING = {
    path: "/routing",
    body: {
      projects: [
        { projectKey: "OPS", apps: ["Uguryldz/maestro-pilot"], noteKey: "routing.note.active_by_rule" },
        { projectKey: "KREDI", apps: [], noteKey: "routing.note.active_by_rule" },
      ],
      rules: [],
      policy: { backendByClass: {}, whenOnpremMissing: "block" },
    },
  };
  const REGISTRY = {
    path: "/studio/apps",
    body: {
      items: [
        {
          appId: "Uguryldz/maestro-pilot",
          displayName: "maestro-pilot",
          adoProject: "Uguryldz",
          adoRepo: "maestro-pilot",
          platform: "linux-node",
          jiraComponent: null,
          jiraProjectKey: "OPS",
          maestroYamlPresent: true,
          createdVia: "onboarding",
        },
      ],
      nextCursor: null,
    },
  };
  const SCM_CONNS = {
    path: "/onboarding/scm-connections",
    body: { connections: [{ id: "github", kind: "github", displayName: "GitHub" }] },
  };
  const SCM_REPOS = {
    // stubFetch strips the query string before matching, so the path is bare.
    path: "/onboarding/scm-repos",
    body: { ok: true, repos: [{ id: "1", fullName: "Uguryldz/maestro-pilot" }, { id: "2", fullName: "Uguryldz/kredi-api" }] },
  };
  const ADDED = { path: "/onboarding/apps", method: "POST", status: 201, body: { appId: "Uguryldz/kredi-api", projectKey: "KREDI" } };
  const STUBS = [OPTIONS, ROUTING, REGISTRY, SCM_CONNS, SCM_REPOS, ADDED];

  it("lists the registered repositories grouped by their bound project, with the platform profile", async () => {
    const { fetchImpl } = stubFetch(STUBS);
    renderScreen(<ReposScreen />, { fetchImpl });

    expect(await screen.findByText("Uguryldz/maestro-pilot")).toBeInTheDocument();
    // The project column names the owner (it is also an option in the add form below).
    expect(screen.getAllByText("OPS").length).toBeGreaterThan(0);
    // The platform comes from the registry, as its readable name — never the slug.
    expect(screen.getByText("Linux (Node.js, Java/Maven, web)")).toBeInTheDocument();
    // The wizard link stays: binding a NEW project is the wizard's job.
    expect(screen.getByRole("link", { name: /Kurulum sihirbazı/ })).toHaveAttribute("href", "/setup");
  });

  it("carries none of the binding's settings: no gate set, merge mode, data class, dry run or admin approval", async () => {
    const { fetchImpl, calls } = stubFetch(STUBS);
    renderScreen(<ReposScreen />, { fetchImpl });

    await screen.findByText("+ Depo ekle");
    for (const label of ["Kapı seti", "Yayınlama modu", "Jira bağlantısı"]) {
      expect(screen.queryByLabelText(label)).toBeNull();
    }
    for (const name of ["Kuru koşum yap", "Admin onayına gönder"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    // Neither the proposal endpoint nor the dry run is ever called from here.
    expect(calls.some((c) => c.url.endsWith("/onboarding") || c.url.endsWith("/onboarding/dry-run"))).toBe(false);
  });

  it("registers a repository under a BOUND project with POST /onboarding/apps, then refreshes the list", async () => {
    const { fetchImpl, calls } = stubFetch(STUBS);
    renderScreen(<ReposScreen />, { fetchImpl });

    // Only bound projects are offered — a project is bound in the wizard, not here.
    await screen.findByRole("option", { name: "KREDI" });
    const project = screen.getByLabelText("Proje");
    expect([...project.querySelectorAll("option")].map((o) => o.textContent)).toEqual(["— proje seç —", "OPS", "KREDI"]);
    await userEvent.selectOptions(project, "KREDI");

    // One SCM connection and one platform profile: both fill themselves and hide.
    expect(screen.queryByLabelText("SCM bağlantısı")).toBeNull();
    expect(screen.queryByLabelText("Platform profili")).toBeNull();
    expect(calls.some((c) => c.url.includes("/onboarding/scm-repos?connectionId=github"))).toBe(true);

    const submit = screen.getByRole("button", { name: "Depo ekle" });
    expect(submit).toBeDisabled();
    await screen.findByRole("option", { name: "Uguryldz/kredi-api" });
    await userEvent.selectOptions(screen.getByLabelText("Repo"), "Uguryldz/kredi-api");
    expect(submit).toBeEnabled();
    await userEvent.click(submit);

    const post = await waitFor(() => {
      const found = calls.find((c) => c.method === "POST" && c.url.endsWith("/onboarding/apps"));
      expect(found).toBeDefined();
      return found!;
    });
    expect(post.body).toEqual({ jiraProject: "KREDI", adoRepo: "Uguryldz/kredi-api", platform: "linux-node" });
    expect(await screen.findByText(/Uguryldz\/kredi-api deposu KREDI projesine kaydedildi/)).toBeInTheDocument();
    // The list is re-read so the new repository shows up under its project.
    await waitFor(() => expect(calls.filter((c) => c.method === "GET" && c.url.endsWith("/routing")).length).toBeGreaterThan(1));
  });

  it("asks for the SCM connection and the platform when there is more than one of each", async () => {
    const { fetchImpl } = stubFetch([
      ...STUBS.filter((s) => s !== OPTIONS && s !== SCM_CONNS),
      { path: "/onboarding/options", body: { jiraProjects: ["OPS"], adoRepos: [], platforms: ["linux-node", "windows-dotnet"] } },
      {
        path: "/onboarding/scm-connections",
        body: {
          connections: [
            { id: "github", kind: "github", displayName: "GitHub" },
            { id: "ado", kind: "ado", displayName: "Azure DevOps" },
          ],
        },
      },
    ]);
    renderScreen(<ReposScreen />, { fetchImpl });

    await screen.findByText("+ Depo ekle");
    expect(await screen.findByLabelText("SCM bağlantısı")).toBeInTheDocument();
    expect(await screen.findByLabelText("Platform profili")).toBeInTheDocument();
    // Before an SCM connection is picked, the repo select prompts for one.
    expect(screen.getByText("Önce SCM bağlantısı seç")).toBeInTheDocument();
  });

  it("says the refusal in the operator's words when the BFF rejects the repository", async () => {
    const { fetchImpl } = stubFetch([
      ...STUBS.filter((s) => s !== ADDED),
      { path: "/onboarding/apps", method: "POST", status: 404, body: { error: "unbound_project", messageKey: "error.unbound_project" } },
    ]);
    renderScreen(<ReposScreen />, { fetchImpl });

    await screen.findByRole("option", { name: "KREDI" });
    await userEvent.selectOptions(screen.getByLabelText("Proje"), "KREDI");
    await screen.findByRole("option", { name: "Uguryldz/kredi-api" });
    await userEvent.selectOptions(screen.getByLabelText("Repo"), "Uguryldz/kredi-api");
    await userEvent.click(screen.getByRole("button", { name: "Depo ekle" }));

    // The catalog's sentence for the BFF's code, never the raw body.
    expect(await screen.findByText("Bu proje bağlı değil; önce projeyi bağlayın.")).toBeInTheDocument();
    expect(screen.queryByText(/deposu KREDI projesine kaydedildi/)).toBeNull();
  });

  it("with no bound project, offers nothing to add to and points at the wizard", async () => {
    const { fetchImpl } = stubFetch([
      ...STUBS.filter((s) => s !== ROUTING),
      { path: "/routing", body: { projects: [], rules: [], policy: { backendByClass: {}, whenOnpremMissing: "block" } } },
    ]);
    renderScreen(<ReposScreen />, { fetchImpl });

    expect((await screen.findAllByText(/Bağlı proje yok — önce Kurulum sihirbazıyla/)).length).toBeGreaterThan(0);
    expect(screen.getByLabelText("Proje")).toBeDisabled();
  });
});
