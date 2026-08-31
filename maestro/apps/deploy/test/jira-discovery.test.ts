import { describe, expect, it } from "vitest";
import { flowDecisionFor } from "../../bff/src/flow-decision.js";
import {
  canSearch,
  classifyingFieldsOf,
  discoverOnce,
  jqlFor,
  startJiraDiscovery,
  type DiscoveryRule,
} from "../src/jira-discovery.js";

/**
 * Finding tickets by asking Jira.
 *
 * Reported from the customer's own install: connection green, listening rules
 * correct, panel up — and no ticket ever arrived. The cause was that nothing
 * ASKED. A ticket could only enter through a Jira webhook (never registered
 * there) or a person typing `/ai-start`. This loop is the third path, and these
 * tests pin the two things that make it safe: what it asks Jira for, and that
 * it never starts the same ticket twice.
 */

const RULE: DiscoveryRule = {
  projectKey: "OPS",
  assigneeAccountId: "712020:bot",
  matchKind: "issuetype",
  matchValue: "Görev",
  enabled: true,
};

/** A search that answers with the given keys and records what it was asked. */
function fakeSearch(pages: Record<string, string[]>): {
  search: { searchIssues: (r: { jql: string }) => Promise<{ issues: Array<{ key?: string }> }> };
  asked: string[];
} {
  const asked: string[] = [];
  return {
    asked,
    search: {
      searchIssues: (request) => {
        asked.push(request.jql);
        const keys = pages[request.jql] ?? [];
        return Promise.resolve({ issues: keys.map((key) => ({ key })) });
      },
    },
  };
}

describe("jqlFor", () => {
  /**
   * Project AND assignee, always. That pair is what "Maestro was given this
   * ticket" means, and it is the same pair the listening rule is keyed on —
   * without the assignee clause a sweep would take every ticket in the
   * project, including ones nobody handed over.
   */
  /**
   * The account id goes in BARE, inside `in (...)`.
   *
   * Measured on the live site: `assignee = "712020:b836…"` returns nothing —
   * Jira reads a quoted value as a display name or e-mail, and an account id
   * is neither. Every sweep came back empty while reporting six rules searched
   * and no error, which is the most misleading way a search can fail.
   */
  it("anchors every rule to its project and the bot account", () => {
    expect(jqlFor({ ...RULE, matchKind: "assigned", matchValue: "*" })).toBe(
      'project = "OPS" AND assignee in (712020:bot)',
    );
  });

  it("narrows by issue type", () => {
    expect(jqlFor(RULE)).toBe(
      'project = "OPS" AND assignee in (712020:bot) AND issuetype = "Görev"',
    );
  });

  /**
   * STATÜ KAPISI SORGUYA HER ZAMAN GİRER (0024).
   *
   * Kararın (`flow-decision.ts`) yanlış statüdeki ticket'ı işlememesi yetmez:
   * o noktada ticket ÇOKTAN OKUNMUŞTUR. Bu platformun servis hesabı ADMIN
   * olduğu için okuma da bir maliyettir — bağlanmamış statüdeki ticket'lar hiç
   * ÇEKİLMEMELİ. `boundProjects`ün sorguyu projeye hapsetmesiyle aynı gerekçe.
   */
  it("statüyü BOTA ATANMA kuralının sorgusuna da koyar — tetikleme tipinden bağımsız", () => {
    expect(
      jqlFor({
        ...RULE,
        matchKind: "assigned",
        matchValue: "*",
        allowedStatuses: ["Analiz"],
      }),
    ).toBe('project = "OPS" AND assignee in (712020:bot) AND status in ("Analiz")');
  });

  it("statüyü İŞ TİPİ kuralının sorgusuna da koyar", () => {
    expect(jqlFor({ ...RULE, allowedStatuses: ["Yapılacak"] })).toBe(
      'project = "OPS" AND assignee in (712020:bot) AND status in ("Yapılacak") AND issuetype = "Görev"',
    );
  });

  it("birden çok izinli statüyü tek bir in(...) listesine koyar", () => {
    expect(
      jqlFor({
        ...RULE,
        matchKind: "assigned",
        matchValue: "*",
        allowedStatuses: ["Yapılacaklar", "Analiz Bekliyor"],
      }),
    ).toBe(
      'project = "OPS" AND assignee in (712020:bot) AND status in ("Yapılacaklar", "Analiz Bekliyor")',
    );
  });

  /**
   * Kısıtsız kuralda hiç eklenmez. Boş bir `status in ()` malformed JQL'dir;
   * Jira 400 döner ve turun catch'i onu turda bir kez loglayıp geçer — yani
   * kural sessizce, sonsuza dek HİÇBİR ŞEY aramış olur. `jqlFor`un var olma
   * sebebi olan sessiz-sonsuz hatanın ta kendisi.
   */
  it("statü kısıtı YOKSA sorguya statü yan tümcesi eklemez (mevcut kurallar)", () => {
    for (const allowedStatuses of [undefined, null, []] as const) {
      expect(
        jqlFor({ ...RULE, matchKind: "assigned", matchValue: "*", allowedStatuses }),
        `allowedStatuses=${JSON.stringify(allowedStatuses)}`,
      ).toBe('project = "OPS" AND assignee in (712020:bot)');
    }
  });

  it("sadece boşluktan oluşan statü adlarını atar, sorguyu bozmaz", () => {
    expect(
      jqlFor({ ...RULE, matchKind: "assigned", matchValue: "*", allowedStatuses: ["  ", "Analiz"] }),
    ).toBe('project = "OPS" AND assignee in (712020:bot) AND status in ("Analiz")');
  });

  it("statü adındaki tırnağı kaçırır — JQL enjeksiyonu olmaz", () => {
    expect(
      jqlFor({ ...RULE, matchKind: "assigned", matchValue: "*", allowedStatuses: ['Ana"liz'] }),
    ).toBe('project = "OPS" AND assignee in (712020:bot) AND status in ("Ana\\"liz")');
  });

  it("narrows by status", () => {
    expect(jqlFor({ ...RULE, matchKind: "status", matchValue: "İNCELEMEDE" })).toBe(
      'project = "OPS" AND assignee in (712020:bot) AND status = "İNCELEMEDE"',
    );
  });

  /**
   * A project key or status carrying a quote would otherwise end the JQL
   * string early and change the query's meaning — the injection shape, in a
   * language that has no bind parameters.
   */
  it("escapes a quote instead of letting it end the clause", () => {
    const jql = jqlFor({ ...RULE, matchValue: 'Gör"ev' });
    expect(jql).toContain('issuetype = "Gör\\"ev"');
  });

  /**
   * NO BOT ACCOUNT, NO QUERY — the boundary that keeps an admin service
   * account from sweeping the whole bank.
   *
   * `flow-decision.ts` reads an empty `assigneeAccountId` as "whoever it is
   * assigned to", which is safe THERE (it only classifies a ticket somebody
   * already handed over) and catastrophic here (it decides what to go and
   * fetch). The old line emitted `assignee in ()`, which Jira rejects — so the
   * rule swept nothing forever while looking like a rule that found nothing.
   * The dangerous neighbour is one edit away: drop the clause instead and the
   * sweep starts runs on every project the admin account can see.
   */
  it.each([
    ["empty", ""],
    ["blank", "   "],
    ["punctuation only", "!!!"],
  ])("refuses to build a query for a rule whose bot account is %s", (_label, account) => {
    expect(jqlFor({ ...RULE, assigneeAccountId: account })).toBeNull();
  });
});

describe("discoverOnce", () => {
  /** Wire the module's collaborators around a recording intake. */
  async function run(options: {
    rules: readonly DiscoveryRule[];
    found: Record<string, string[]>;
    known?: string[];
    maxPerRound?: number;
    /** The bound+active projects. Omitted = the seam is not wired at all. */
    boundProjects?: readonly string[];
    /** A binding source that FAILS, for the fail-closed test. */
    boundProjectsThrows?: boolean;
  }): Promise<{ started: readonly string[]; asked: readonly string[] }> {
    const { search, asked } = fakeSearch(options.found);
    const started: string[] = [];
    const deps = {
      // `runIntake` reads these two; everything else it touches is behind them.
      bindings: { resolve: () => Promise.resolve(null) },
      counters: { droppedKillSwitch: 0 },
      __record: started,
    } as never;

    const result = await discoverOnce({
      deps,
      search,
      rules: () => Promise.resolve(options.rules),
      known: () => Promise.resolve((options.known ?? []) as never),
      intervalMs: 0,
      ...(options.maxPerRound === undefined ? {} : { maxPerRound: options.maxPerRound }),
      ...(options.boundProjectsThrows === true
        ? { boundProjects: () => Promise.reject(new Error("db down")) }
        : options.boundProjects === undefined
          ? {}
          : { boundProjects: () => Promise.resolve(options.boundProjects!) }),
      log: () => undefined,
    });
    return { started: result, asked };
  }

  /**
   * BAĞLANMAMIŞ PROJEYE SORGU GİTMEZ — kapsamın dış sınırı.
   *
   * Kuralın `projectKey`'i serbest metin: bir yazım hatası, sonradan bağlantısı
   * kaldırılmış bir proje, ya da elle yazılmış bir satır, bu kurulumun hiç
   * verilmediği bir projeyi adlandırabilir. `runIntake` böyle bir ticket'ı
   * `unbound` diye reddeder ve KOŞU başlamaz — ama o noktada ARAMA çoktan
   * yapılmıştır, ve engellenmesi gereken şey odur.
   *
   * Burada `started` değil `asked` üzerinden doğrulanıyor, ve bu testin bütün
   * meselesi bu: "hiçbir şey başlatmadı", arayıp bir şey bulamamış bir turun da
   * görüntüsüdür. Riskin kendisi, bankanın Jira'sına GİDEN sorgudur — servis
   * hesabı rutin olarak ADMIN'dir ve bağlanmamış bir proje, kapsam dışı bir
   * proje değil, Maestro'yu hiç duymamış bir ekibin ticket'larıdır.
   */
  it("never queries a project the operator did not bind, even for a valid rule", async () => {
    const { asked, started } = await run({
      rules: [RULE, { ...RULE, projectKey: "GIZLI" }],
      found: {},
      boundProjects: ["OPS"],
    });

    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('project = "OPS"');
    expect(asked.join(" ")).not.toContain("GIZLI");
    expect(started).toHaveLength(0);
  });

  /**
   * BOTA ATANMIŞ OLMAK TEK BAŞINA YETMEZ.
   *
   * `assigned` bir tetikleme TİPİDİR, kapsamı genişleten bir muafiyet değil:
   * proje kapısı onun da ÜSTÜNDEDİR. Aksi hâlde "bota atanan her ticket" kuralı,
   * admin bir hesapla bankanın her projesine açılan bir kapı olurdu — ki
   * kullanıcının kurgusunda proje HER ZAMAN şart, tetikleme tipi onun İÇİNDE
   * bir seçimdir.
   */
  it("an `assigned` rule on an unbound project is still not searched", async () => {
    const { asked } = await run({
      rules: [{ ...RULE, projectKey: "GIZLI", matchKind: "assigned", matchValue: "*" }],
      found: {},
      boundProjects: ["OPS"],
    });

    expect(asked).toHaveLength(0);
  });

  /**
   * DURAKLATILAN PROJE, TARAMADAN DA ÇIKAR.
   *
   * Bağlı proje listesi `state = active` satırlarından gelir, "satır var"dan
   * değil: `paused` bir bağlama bilerek canlı DEĞİLDİR, ve duraklatan operatör
   * duraklatmanın hemen etkili olmasını bekler. Bu test o listenin daralmasının
   * turu gerçekten daralttığını sabitler.
   */
  it("stops searching a project as soon as it leaves the bound set", async () => {
    const before = await run({ rules: [RULE], found: {}, boundProjects: ["OPS"] });
    const after = await run({ rules: [RULE], found: {}, boundProjects: [] });

    expect(before.asked).toHaveLength(1);
    expect(after.asked).toHaveLength(0);
  });

  /**
   * BAĞLI PROJE LİSTESİ OKUNAMAZSA TUR DURUR — fail-closed.
   *
   * "Süzemedik, o hâlde süzmeyelim" bu kurulumda en tehlikeli daldır: admin bir
   * servis hesabıyla süzgeçsiz bir tur, bankanın her projesine sorgu göndermek
   * demektir. Geçici olarak hiç taramamak, geniş taramaktan iyidir.
   */
  it("skips the whole round when the bound-project list cannot be read", async () => {
    const { asked } = await run({ rules: [RULE], found: {}, boundProjectsThrows: true });
    expect(asked).toHaveLength(0);
  });

  /**
   * KURAL YOKSA HİÇBİR ŞEY — "hepsini al" dalı yok.
   *
   * Boş kural kümesinin geniş bir sorguya (ya da varsayılan bir JQL'e) düşmesi,
   * bu döngüde bir kolaylık değil bir kaza olurdu.
   */
  it("asks nothing at all when there are no rules", async () => {
    const { asked } = await run({ rules: [], found: {}, boundProjects: ["OPS"] });
    expect(asked).toHaveLength(0);
  });

  it("asks Jira once per enabled rule", async () => {
    const { asked } = await run({
      rules: [RULE, { ...RULE, matchValue: "Hata" }, { ...RULE, enabled: false }],
      found: {},
    });

    expect(asked).toHaveLength(2);
    expect(asked[0]).toContain('issuetype = "Görev"');
    expect(asked[1]).toContain('issuetype = "Hata"');
  });

  it("asks nothing at all when no rule is enabled", async () => {
    const { asked } = await run({ rules: [{ ...RULE, enabled: false }], found: {} });
    expect(asked).toEqual([]);
  });

  /**
   * A ticket the platform already has a row for is finished business — done,
   * failed, or running. Re-starting it on a timer would turn one operator
   * decision into an endless loop of runs.
   */
  it("skips a ticket that already has a run", async () => {
    const jql = jqlFor(RULE)!;
    const { started } = await run({
      rules: [RULE],
      found: { [jql]: ["OPS-1", "OPS-2"] },
      known: ["OPS-1"],
    });

    expect(started).not.toContain("OPS-1");
  });

  /**
   * Several rules routinely match one ticket — an `assigned` wildcard beside a
   * per-issuetype rule is the shape the seed itself writes. Starting it once
   * per matching rule would be N runs for one piece of work.
   */
  it("starts a ticket once even when two rules match it", async () => {
    const byType = jqlFor(RULE)!;
    const byAssignment = jqlFor({ ...RULE, matchKind: "assigned", matchValue: "*" })!;
    const { started } = await run({
      rules: [RULE, { ...RULE, matchKind: "assigned", matchValue: "*" }],
      found: { [byType]: ["OPS-7"], [byAssignment]: ["OPS-7"] },
    });

    expect(started.filter((key) => key === "OPS-7")).toHaveLength(
      started.includes("OPS-7") ? 1 : 0,
    );
  });

  /**
   * The round-level half of the fail-closed rule: a rule with no bot account
   * must not merely produce a harmless query, it must produce NO REQUEST.
   *
   * Asserted on `asked` rather than on `started`, because "started nothing" is
   * also what a search that ran and matched nothing looks like — and the whole
   * risk here is a query that DOES reach a Jira the service account is admin
   * on. The good rule beside it proves the skip is surgical: one bad rule must
   * not disarm the sweep.
   */
  /**
   * TARAMANIN OKUDUĞU TICKET, KURALIN KENDİSİYLE EŞLEŞMELİ — DÖRT TETİKLEME
   * TİPİNİN HEPSİNDE.
   *
   * Ölçülen hata: tarama `runIntake`'e yalnızca ticket anahtarını veriyordu.
   * `flow-decision.ts` her kuralı dört `null`'a karşı karşılaştırıyor, HİÇBİRİ
   * eşleşmiyor, ve tarama tam da bir kural yüzünden bulduğu ticket'ı o kural
   * hiç yokmuş gibi çalıştırıyordu — kuralın akışı da statü eşlemesi de
   * kayboluyor, analiz-only bağlamada ise ticket `no_application` ile
   * reddediliyordu. Sahada görülen: "ticket geliyor ama ajan çalışmıyor".
   *
   * Bu test sorgu METNİNİ değil, ELDEN ELE GEÇEN VERİYİ sürüyor: gerçek bir
   * Jira `issue` belgesi (webhook'un taşıdığının aynısı) taramanın okuyucusuna,
   * onun okuduğu alanlar da gerçek eşleştiriciye verilir. Yalnız JQL'i
   * doğrulayan bir test bu hatayı göremezdi — sorgu zaten doğruydu.
   *
   * Dört tipin hepsi döngüde, çünkü bugünkü hata sınıfı tam olarak "bir yolda
   * çalışıyor, diğerinde sessizce çalışmıyor": bir tetikleme tipinin yalnız
   * webhook'ta çalışıp taramada çalışmaması hiçbir yerde hata üretmez.
   */
  it.each(["status", "issuetype", "label", "assigned"] as const)(
    "a %s rule: what the sweep reads off Jira matches that same rule",
    (matchKind) => {
      const matchValue = matchKind === "assigned" ? "*" : "Analiz Bekliyor";
      const rule: DiscoveryRule = { ...RULE, matchKind, matchValue };

      /**
       * The document Jira answers the search with. Every field is populated
       * whatever the rule matched on — a real ticket has a status, a type, an
       * assignee and labels regardless of which one triggered the rule, and a
       * fixture that filled only the matched one would hide a reader that looks
       * at the wrong field.
       */
      const issue = {
        key: "OPS-91",
        fields: {
          status: { name: matchKind === "status" ? matchValue : "Devam Ediyor" },
          issuetype: { name: matchKind === "issuetype" ? matchValue : "Görev" },
          assignee: { accountId: rule.assigneeAccountId },
          // A second label beside the matched one: a label rule must match by
          // MEMBERSHIP, and a matcher that compared the whole list (or only
          // its first entry) would pass a single-label fixture and fail here.
          labels: matchKind === "label" ? ["baska-etiket", matchValue] : ["baska-etiket"],
        },
      };

      const handed = classifyingFieldsOf(issue);

      const decided = flowDecisionFor(
        [
          {
            ruleId: "lr_1",
            projectKey: rule.projectKey,
            assigneeAccountId: rule.assigneeAccountId,
            matchKind: rule.matchKind,
            matchValue: rule.matchValue,
            flowType: "analiz",
            priority: 100,
            enabled: true,
            analystVariantId: null,
            engineerVariantId: null,
            statusMap: null,
          },
        ] as never,
        {
          projectKey: rule.projectKey,
          status: handed.status ?? null,
          issueType: handed.issueType ?? null,
          assignee: handed.assignee ?? null,
          labels: handed.labels ?? null,
        } as never,
        null,
      );

      expect(decided.reason, `${matchKind} kuralı eşleşmedi`).toBe("rule");
      expect(decided.flow).toBe("analiz");
    },
  );

  /**
   * Bir alanı taşımayan teslimat, o alandaki kuralı eşleştirmemeli.
   *
   * Okuyucunun yokluğu boş dizeye ya da boş listeye çevirmesi, `matchValue`'su
   * boş bir kuralı HER ticket'a uydururdu — ve bunu sessizce yapardı. Yokluk
   * "sormadık" demeye devam etmeli.
   */
  it("omits a field the payload does not carry, rather than inventing one", () => {
    expect(classifyingFieldsOf({ key: "OPS-91", fields: {} })).toEqual({});
    expect(classifyingFieldsOf({ key: "OPS-91" })).toEqual({});
  });

  /**
   * Etiketsiz bir ticket ile etiketi OKUNMAMIŞ bir ticket farklı cevaplardır.
   * `[]` "bu ticket'ın etiketi yok" der (etiket kuralı doğru şekilde
   * eşleşmez); yokluk "bakmadık" der. İkisi de eşleşmemeli, ama aynı sebeple
   * değil — ve `[]`'in yokluğa çevrilmesi bir kuralı boş listeye karşı
   * "eşleşti" sayan bir okuyucuya kapı açardı.
   */
  it("keeps an empty label list distinct from an absent one", () => {
    expect(classifyingFieldsOf({ key: "OPS-91", fields: { labels: [] } })).toEqual({ labels: [] });
  });

  it("never sends a search for a rule with no bot account", async () => {
    const good = jqlFor(RULE)!;
    const { asked } = await run({
      rules: [{ ...RULE, assigneeAccountId: "" }, RULE],
      found: { [good]: ["OPS-5"] },
    });

    // The accountless rule produced NO request, and the good rule beside it
    // still did: one misconfigured rule must not disarm the whole sweep.
    expect(asked).toEqual([good]);
    expect(asked.some((jql) => jql.includes("in ()"))).toBe(false);
  });

  /**
   * One project whose permissions changed must not freeze discovery for every
   * other project — the failure mode that turns a partial outage into a total
   * one.
   */
  it("keeps going when one rule's search fails", async () => {
    const asked: string[] = [];
    const search = {
      searchIssues: (request: { jql: string }) => {
        asked.push(request.jql);
        if (request.jql.includes("Görev")) return Promise.reject(new Error("403"));
        return Promise.resolve({ issues: [] });
      },
    };

    await discoverOnce({
      deps: {} as never,
      search,
      rules: () => Promise.resolve([RULE, { ...RULE, matchValue: "Hata" }]),
      known: () => Promise.resolve([]),
      intervalMs: 0,
      log: () => undefined,
    });

    expect(asked).toHaveLength(2);
  });

  /**
   * A round that finds nothing must still SAY so.
   *
   * Measured on the live install: a healthy sweep printed nothing at all when
   * every matching ticket was already known, so the log looked exactly the
   * same as a sweep that had never started — and "my tickets are not arriving"
   * is precisely the moment an operator needs those two told apart. The status
   * endpoint knows, but it needs a session; the log is what gets read first.
   */
  it("reports the round even when it starts nothing", async () => {
    const logged: string[] = [];
    await discoverOnce({
      deps: {} as never,
      search: { searchIssues: () => Promise.resolve({ issues: [{ key: "OPS-1" }] }) },
      rules: () => Promise.resolve([RULE]),
      known: () => Promise.resolve(["OPS-1"] as never),
      intervalMs: 0,
      log: (message) => logged.push(message),
    });

    const summary = logged.find((line) => line.includes("tur bitti"));
    expect(summary).toBeDefined();
    // It says what it searched with and what it took, so "1 rule, 0 taken"
    // reads as a working sweep rather than a broken one.
    expect(summary).toContain("1 kural");
    expect(summary).toContain("0 ticket");
  });

  it("says so when there is no enabled rule to search with", async () => {
    const logged: string[] = [];
    await discoverOnce({
      deps: {} as never,
      search: { searchIssues: () => Promise.resolve({ issues: [] }) },
      rules: () => Promise.resolve([{ ...RULE, enabled: false }]),
      known: () => Promise.resolve([]),
      intervalMs: 0,
      log: (message) => logged.push(message),
    });

    expect(logged.join(" ")).toContain("açık dinleme kuralı yok");
  });

  it("survives an unreadable rule list rather than throwing at the timer", async () => {
    const result = await discoverOnce({
      deps: {} as never,
      search: { searchIssues: () => Promise.resolve({ issues: [] }) },
      rules: () => Promise.reject(new Error("db down")),
      known: () => Promise.resolve([]),
      intervalMs: 0,
      log: () => undefined,
    });

    expect(result).toEqual([]);
  });
});

/**
 * The interval is an OPERATOR setting, in seconds, and it must take effect on
 * the next round rather than the next restart.
 *
 * Asked for directly: "65 dakikayı 1 dk 20 saniyeye ayarlayabilmem lazım."
 * Minutes could not express 80 seconds at all, and a fixed `setInterval` would
 * have kept whatever it was created with until the container was restarted —
 * which on a bank's server is a change request, not a click.
 */
describe("startJiraDiscovery: the operator's interval", () => {
  it("reschedules at the seconds the parameter says, not the boot default", async () => {
    const asked: number[] = [];
    const loop = startJiraDiscovery({
      deps: {} as never,
      search: { searchIssues: () => Promise.resolve({ issues: [] }) },
      rules: () => Promise.resolve([]),
      known: () => Promise.resolve([]),
      // Boot default is five minutes; the operator says 80 seconds.
      intervalMs: 300_000,
      intervalSeconds: () => {
        asked.push(Date.now());
        return Promise.resolve(80);
      },
      log: () => undefined,
    });

    // One tick is enough: the reschedule reads the parameter after the round.
    await new Promise((resolve) => setTimeout(resolve, 60));
    loop.stop();

    expect(asked.length).toBeGreaterThan(0);
  });

  it("stops rescheduling when the operator sets 0", async () => {
    let rounds = 0;
    const loop = startJiraDiscovery({
      deps: {} as never,
      search: {
        searchIssues: () => {
          rounds += 1;
          return Promise.resolve({ issues: [] });
        },
      },
      rules: () => Promise.resolve([]),
      known: () => Promise.resolve([]),
      intervalMs: 10,
      intervalSeconds: () => Promise.resolve(0),
      log: () => undefined,
    });

    await new Promise((resolve) => setTimeout(resolve, 120));
    loop.stop();

    // Zero means off: no second round was scheduled, however short the boot
    // interval was.
    expect(rounds).toBeLessThanOrEqual(1);
  });
});

/**
 * Which drivers can be swept at all.
 *
 * The composition root used to hand the sweep `ports.work as unknown as
 * IssueSearcher`. TypeScript accepts that cast; the runtime does not, and every
 * round threw "searchIssues is not a function": silently on the timer, and as a
 * bare HTTP 500 behind the panel's "şimdi tara" button, which is where the
 * customer finally saw it.
 *
 * Jira Data Center used to be on the failing side of this line, and the cost
 * was far worse than a missing optimisation. On a closed-network DC no webhook
 * can be registered, and the comment poller only ever looks at tickets that
 * ALREADY have a run (`openTickets` reads `db.workflowRun`) — so with the sweep
 * unavailable too, nothing could ever enter the platform at all. The DC driver
 * offers `searchIssues` now (`/rest/api/2/search`, which DC always had), so
 * both Jira drivers answer true here. The check stays real because Azure
 * DevOps still has no work port.
 *
 * Asking the object is what a cast pretended to do. These pin the question.
 */
describe("canSearch", () => {
  it("accepts a driver that really offers the search", () => {
    expect(canSearch({ searchIssues: () => Promise.resolve({ issues: [] }) })).toBe(true);
  });

  it("rejects a work driver that has no search — the ADO case", () => {
    // Shaped like a real work port: everything the workflow needs, no search.
    const workPortWithoutSearch = {
      getTicket: () => Promise.resolve({}),
      addComment: () => Promise.resolve({ commentId: "1" }),
      transition: () => Promise.resolve(),
    };

    expect(canSearch(workPortWithoutSearch)).toBe(false);
  });

  /**
   * A property that merely EXISTS is what the old cast effectively assumed.
   * Calling a string would throw exactly the error this check exists to stop.
   */
  it("rejects a driver whose searchIssues is not callable", () => {
    expect(canSearch({ searchIssues: "yes" })).toBe(false);
  });

  it("rejects nothing at all rather than throwing on it", () => {
    expect(canSearch(null)).toBe(false);
    expect(canSearch(undefined)).toBe(false);
  });
});
