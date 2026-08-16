import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { SetupScreen } from "../src/screens/Setup.tsx";
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
    { path: "/studio/listening-rules", method: "POST", status: 201, body: { rule: { ruleId: "lr_1" } } },
    { path: "/studio/pilot/listening", method: "POST", body: { ok: true } },
    { path: "/onboarding", method: "POST", body: { proposalId: "pr_1" } },
  ];
  // An override REPLACES the route with the same path+method rather than being
  // appended: the harness matches the first hit, so appending would be ignored.
  const result = routes.filter(
    (r) =>
      !overrides.some((o) => o.path === r.path && (o.method ?? "GET") === (r.method ?? "GET")),
  );
  return [...overrides, ...result];
}

/** Walk step 1 → step 2 by accepting the default flow, or picking another. */
async function chooseFlow(flow?: "duzeltme" | "gelistirme"): Promise<void> {
  await screen.findByText("Ne yapmak istiyorsunuz?");
  if (flow !== undefined) {
    const label = flow === "duzeltme" ? "Hata düzeltme" : "Yeni özellik geliştirme";
    await userEvent.click(screen.getByRole("radio", { name: new RegExp(label) }));
  }
  await userEvent.click(screen.getByRole("button", { name: "İleri" }));
}

/** Fill step 2 (project + repo + platform) and move on. */
async function fillProject(): Promise<void> {
  await screen.findByText("Hangi Jira projesi, hangi uygulama?");
  await userEvent.selectOptions(screen.getByLabelText("Jira bağlantısı"), "jira-1");
  await screen.findByRole("option", { name: "OPS · Operasyon" });
  await userEvent.selectOptions(screen.getByLabelText("Jira projesi"), "OPS");
  await userEvent.selectOptions(screen.getByLabelText("Kod deposu bağlantısı"), "scm-1");
  await screen.findByRole("option", { name: "Uguryldz/maestro-pilot" });
  await userEvent.selectOptions(screen.getByLabelText("Kod deposu"), "Uguryldz/maestro-pilot");
  await userEvent.selectOptions(screen.getByLabelText("Uygulamanın teknolojisi"), "linux-node");
  await userEvent.click(screen.getByRole("button", { name: "İleri" }));
}

/** Fill step 3 (which tickets) and move on. */
async function fillTickets(value = "Hata"): Promise<void> {
  await screen.findByText("Hangi ticket'ları alsın?");
  // The value list is read live off the project, so it is a dropdown.
  await screen.findByRole("option", { name: value });
  await userEvent.selectOptions(screen.getByLabelText("Hangi değer?"), value);
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
  it("opens on the flow question, described by outcome rather than by jargon", async () => {
    const { fetchImpl } = stubFetch(baseRoutes());
    renderScreen(<SetupScreen />, { fetchImpl });

    await screen.findByText("Ne yapmak istiyorsunuz?");
    // The three flows, each with the sentence that says what it DOES. Nothing
    // on this screen says "risk_tiered" or "opt_in" — that is the whole point.
    expect(
      screen.getByText("Maestro talebi inceleyip analiz belgesi hazırlasın; kod yazmasın."),
    ).toBeTruthy();
    expect(screen.getByRole("radio", { name: /Hata düzeltme/ })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /Yeni özellik geliştirme/ })).toBeTruthy();
    // Analysis leads: a first-time operator clicking straight through must end
    // up with the flow that cannot touch a repository.
    expect((screen.getByRole("radio", { name: /Yalnızca analiz/ }) as HTMLInputElement).checked).toBe(
      true,
    );
  });

  it("creates the rule with the chosen flow and no status map on the happy path", async () => {
    const { fetchImpl, calls } = stubFetch(baseRoutes());
    renderScreen(<SetupScreen />, { fetchImpl });

    await chooseFlow("duzeltme");
    await fillProject();
    await fillTickets();

    // Step 4 is skipped without touching it — the wizard says so on the button.
    await screen.findByText("Jira durumlarını da değiştirsin mi?");
    expect(screen.getByText("Bu adım isteğe bağlı; dokunmadan geçebilirsiniz.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "İleri" }));

    // Step 5 spells the configuration back as sentences, not as a field dump.
    await screen.findByText("Özet");
    expect(
      screen.getByText(
        "OPS projesinde, bota atanmış ve İş tipi değeri \"Hata\" olan ticket'lar Hata düzeltme akışıyla çalışacak.",
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
      expect(body.flowType).toBe("duzeltme");
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

    await chooseFlow("gelistirme");
    await fillProject();
    await fillTickets();
    await userEvent.click(await screen.findByRole("button", { name: "İleri" }));
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
        triggerMode: "opt_in",
        gateSet: "always_six",
        mergeMode: "human",
      });
    });
  });

  it("says the binding waits for a second admin rather than looking like a failure", async () => {
    const { fetchImpl } = stubFetch(baseRoutes());
    renderScreen(<SetupScreen />, { fetchImpl });

    await chooseFlow();
    await fillProject();
    await fillTickets();
    await userEvent.click(await screen.findByRole("button", { name: "İleri" }));

    // Stated BEFORE the button, so the wait is expected rather than discovered.
    await screen.findByText("Özet");
    expect(screen.getByText(/ikinci bir yöneticinin onayını bekler/)).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Kurulumu tamamla" }));

    // And again afterwards, with the two concrete next actions.
    expect(await screen.findByText("Kurulum tamam")).toBeTruthy();
    expect(screen.getByText(/ikinci bir yöneticinin onayını bekliyor/)).toBeTruthy();
    expect(
      screen.getByText(
        "OPS projesinde İş tipi değeri \"Hata\" olan bir ticket açın (ya da mevcut birini o değere getirin).",
      ),
    ).toBeTruthy();
    expect(screen.getByText(/Ticket'ı Maestro botuna atayın/)).toBeTruthy();
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
      ]),
    );
    renderScreen(<SetupScreen />, { fetchImpl });

    await chooseFlow();
    await fillProject();
    await fillTickets();
    await userEvent.click(await screen.findByRole("button", { name: "İleri" }));
    await screen.findByText("Özet");

    // Promising a four-eyes approval for a live binding sends the operator
    // looking for an approval queue that has nothing in it.
    expect(
      screen.getByText(/OPS projesi zaten bağlı; yeni bir bağlama önerisi oluşturulmayacak/),
    ).toBeTruthy();
    expect(screen.queryByText(/ikinci bir yöneticinin onayını bekler/)).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Kurulumu tamamla" }));
    await screen.findByText("Kurulum tamam");
    expect(calls.find((c) => c.url.endsWith("/onboarding") && c.method === "POST")).toBeUndefined();
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

    async function reachStatusStep(): Promise<void> {
      await chooseFlow();
      await fillProject();
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

      await chooseFlow();
      await fillProject();
      // With a live list every value is picked, never spelled.
      await fillTickets("İNCELEMEDE");
      await screen.findByText("Jira durumlarını da değiştirsin mi?");
      await userEvent.click(screen.getByLabelText("Ticket'ın Jira durumunu da değiştirsin"));

      const onStart = (await screen.findByLabelText("İş başladığında")) as HTMLSelectElement;
      expect([...onStart.options].map((o) => o.value)).toEqual(["", ...OPS_STATUSES]);
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

      await chooseFlow("gelistirme");
      await fillProject();
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
      await userEvent.click(screen.getByRole("button", { name: "Geri" }));
      await screen.findByText("Ne yapmak istiyorsunuz?");
      expect(
        (screen.getByRole("radio", { name: /Yeni özellik geliştirme/ }) as HTMLInputElement).checked,
      ).toBe(true);

      // … and forward again. Nothing was dropped by the round trip: "geri
      // gidince yazdıklarım gitti" is what makes a wizard worse than a form.
      await userEvent.click(screen.getByRole("button", { name: "İleri" }));
      await screen.findByText("Hangi Jira projesi, hangi uygulama?");
      expect((screen.getByLabelText("Jira projesi") as HTMLSelectElement).value).toBe("OPS");
      expect((screen.getByLabelText("Kod deposu") as HTMLSelectElement).value).toBe(
        "Uguryldz/maestro-pilot",
      );
      expect((screen.getByLabelText("Uygulamanın teknolojisi") as HTMLSelectElement).value).toBe(
        "linux-node",
      );

      await userEvent.click(screen.getByRole("button", { name: "İleri" }));
      await screen.findByText("Hangi ticket'ları alsın?");
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
      const { fetchImpl } = stubFetch(baseRoutes());
      renderScreen(<SetupScreen />, { fetchImpl });

      await chooseFlow();
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

    it("names the missing repository connection", async () => {
      const { fetchImpl } = stubFetch(
        baseRoutes([{ path: "/onboarding/scm-connections", body: { connections: [] } }]),
      );
      renderScreen(<SetupScreen />, { fetchImpl });
      expect(await screen.findByText(/Hiç kod deposu bağlantısı tanımlı değil/)).toBeTruthy();
    });

    it("does not accuse an empty list while the request is still in flight", async () => {
      // A never-resolving connections call: the warning must not appear on the
      // strength of "the array is empty so far".
      const { fetchImpl } = stubFetch(baseRoutes());
      renderScreen(<SetupScreen />, { fetchImpl });
      await screen.findByText("Ne yapmak istiyorsunuz?");
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

    await chooseFlow();
    await fillProject();
    await fillTickets();
    await userEvent.click(await screen.findByRole("button", { name: "İleri" }));
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

  it("does not file a binding proposal when the rule write failed", async () => {
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

    await chooseFlow();
    await fillProject();
    await fillTickets();
    await userEvent.click(await screen.findByRole("button", { name: "İleri" }));
    await screen.findByText("Özet");
    await userEvent.click(screen.getByRole("button", { name: "Kurulumu tamamla" }));
    await screen.findByText(/Bu ticket'lar için zaten bir dinleme kuralı var/);

    // A pending four-eyes approval for a setup that never completed is worse
    // than no approval at all: somebody would approve a binding whose rule
    // does not exist.
    expect(calls.find((c) => c.url.endsWith("/onboarding") && c.method === "POST")).toBeUndefined();
  });
});
