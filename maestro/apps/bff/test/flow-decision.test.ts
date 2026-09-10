import { describe, expect, it } from "vitest";
import {
  flowDecisionFor,
  ruleFor,
  rulesFor,
  statusGateOf,
  type ClassifiableTicket,
} from "../src/flow-decision.js";
import type { ListeningRuleRecord } from "../src/listening-store.js";

/**
 * Per-ticket flow selection.
 *
 * The point of this module is that TWO TICKETS IN ONE PROJECT can run different
 * flows — the thing `flowOf(env)` could not express, because it read the flow
 * off the process environment and so bound the whole deployment to one answer.
 */

function rule(over: Partial<ListeningRuleRecord> = {}): ListeningRuleRecord {
  return {
    ruleId: "lr_1",
    projectKey: "OPS",
    assigneeAccountId: "",
    matchKind: "issuetype",
    matchValue: "Hata",
    flowType: "duzeltme",
    priority: 100,
    enabled: true,
    ...over,
  };
}

function ticket(over: Partial<ClassifiableTicket> = {}): ClassifiableTicket {
  return { projectKey: "OPS", status: null, issueType: null, assignee: null, ...over };
}

describe("flowDecisionFor — two tickets, one project, different flows", () => {
  // The headline behaviour. Both rules live in project OPS and both are
  // enabled; only the ticket differs.
  const rules = [
    rule({ ruleId: "lr_bug", matchKind: "issuetype", matchValue: "Hata", flowType: "duzeltme", priority: 10 }),
    rule({ ruleId: "lr_analysis", matchKind: "issuetype", matchValue: "Analiz", flowType: "analiz", priority: 20 }),
  ];

  it("routes a 'Hata' ticket to the engineering fix flow", () => {
    const decision = flowDecisionFor(rules, ticket({ issueType: "Hata" }), null);
    /**
     * `statusMap: null` is comment-only mode — these rules map no columns, so
     * the decision says so explicitly rather than leaving the field absent.
     *
     * `gateSteps: null` AYNI DURUŞ, aynı gerekçe: kural kapı dizisi SEÇMEDİ,
     * dolayısıyla kapılar risk seviyesine göre açılacak. Alanı hiç yazmamak
     * ile `null` yazmak arasındaki fark, karar nesnesinin bu soruyu SORMUŞ
     * olup olmadığıdır — ve sormuş olmalı, çünkü kararı veren kural okundu.
     *
     * `toEqual` bilerek: kararın TAM şekli sabitleniyor. Yeni bir alan sessizce
     * eklendiğinde bu test kırılır, ve kırılması gerekir — bu nesne koşunun
     * başlangıç girdisine çivileniyor, yani şekli bir sözleşme.
     */
    expect(decision).toEqual({
      flow: "duzeltme",
      reason: "rule",
      ruleId: "lr_bug",
      statusMap: null,
      gateSteps: null,
    });
  });

  it("routes an 'Analiz' ticket in the SAME project to the analysis flow", () => {
    const decision = flowDecisionFor(rules, ticket({ issueType: "Analiz" }), null);
    expect(decision).toEqual({
      flow: "analiz",
      reason: "rule",
      ruleId: "lr_analysis",
      statusMap: null,
      gateSteps: null,
    });
  });

  it("gives the two tickets genuinely different flows", () => {
    const bug = flowDecisionFor(rules, ticket({ issueType: "Hata" }), null);
    const analysis = flowDecisionFor(rules, ticket({ issueType: "Analiz" }), null);
    expect(bug.flow).not.toBe(analysis.flow);
  });

  it("matches on status as well as issue type", () => {
    const statusRules = [
      rule({ ruleId: "lr_todo", matchKind: "status", matchValue: "Yapılacak", flowType: "gelistirme" }),
    ];
    expect(flowDecisionFor(statusRules, ticket({ status: "Yapılacak" }), null).flow).toBe("gelistirme");
  });
});

describe("flowDecisionFor — fall back to the deployment default", () => {
  it("uses the deployment default when NO rule matches", () => {
    const decision = flowDecisionFor([rule({ matchValue: "Hata" })], ticket({ issueType: "Görev" }), "analiz");
    expect(decision).toEqual({ flow: "analiz", reason: "default" });
  });

  it("uses the deployment default when there are no rules at all", () => {
    expect(flowDecisionFor([], ticket({ issueType: "Hata" }), "analiz")).toEqual({
      flow: "analiz",
      reason: "default",
    });
  });

  it("leaves the flow UNSET when no rule matches and the deployment names no default", () => {
    // `null` flow means the engine's own full-pipeline default (`planFor`).
    expect(flowDecisionFor([], ticket({ issueType: "Hata" }), null)).toEqual({ flow: null, reason: "none" });
    expect(flowDecisionFor([], ticket({ issueType: "Hata" }), undefined)).toEqual({ flow: null, reason: "none" });
  });

  it("lets a matching rule OVERRIDE the deployment default", () => {
    // The whole point: an `analiz` deployment can still run a fix ticket.
    const decision = flowDecisionFor([rule({ flowType: "duzeltme" })], ticket({ issueType: "Hata" }), "analiz");
    expect(decision.flow).toBe("duzeltme");
    expect(decision.reason).toBe("rule");
  });
});

describe("flowDecisionFor — what does NOT match", () => {
  it("ignores a rule belonging to another project", () => {
    const other = [rule({ projectKey: "PAY", flowType: "duzeltme" })];
    expect(flowDecisionFor(other, ticket({ projectKey: "OPS", issueType: "Hata" }), "analiz").reason).toBe("default");
  });

  it("ignores a disabled rule", () => {
    const off = [rule({ enabled: false, flowType: "duzeltme" })];
    expect(flowDecisionFor(off, ticket({ issueType: "Hata" }), "analiz").reason).toBe("default");
  });

  it("ignores a rule whose assignee is not the ticket's assignee", () => {
    const bot = [rule({ assigneeAccountId: "712020:bot", flowType: "duzeltme" })];
    const humanTicket = ticket({ issueType: "Hata", assignee: "ayse.kaya" });
    expect(flowDecisionFor(bot, humanTicket, "analiz").reason).toBe("default");
  });

  it("matches a rule whose assignee IS the ticket's assignee", () => {
    const bot = [rule({ assigneeAccountId: "712020:bot", flowType: "duzeltme" })];
    const botTicket = ticket({ issueType: "Hata", assignee: "712020:bot" });
    expect(flowDecisionFor(bot, botTicket, "analiz").flow).toBe("duzeltme");
  });

  it("treats an empty rule assignee as 'any assignee'", () => {
    const anyone = [rule({ assigneeAccountId: "  ", flowType: "duzeltme" })];
    expect(flowDecisionFor(anyone, ticket({ issueType: "Hata", assignee: "ayse.kaya" }), null).flow).toBe("duzeltme");
  });

  it("does NOT let a field the payload omitted match an empty matchValue", () => {
    // A delivery that carried no status must match nothing, rather than
    // matching a rule whose `matchValue` happens to be empty.
    const empty = [rule({ matchKind: "status", matchValue: "", flowType: "gelistirme" })];
    expect(flowDecisionFor(empty, ticket({ status: null }), "analiz").reason).toBe("default");
  });
});

describe("flowDecisionFor — priority and conflicts (fail-closed)", () => {
  it("lets the lowest priority number win when rules agree on nothing else", () => {
    const rules = [
      rule({ ruleId: "lr_low", matchValue: "Hata", flowType: "duzeltme", priority: 50 }),
      rule({ ruleId: "lr_high", matchValue: "Hata", flowType: "duzeltme", priority: 5 }),
    ];
    expect(ruleFor(rules, ticket({ issueType: "Hata" }))?.ruleId).toBe("lr_high");
  });

  it("takes the NARROWEST flow when two rules disagree, and says so", () => {
    // A status rule and an issuetype rule can both match one ticket; no unique
    // index can prevent that. `analiz` writes no code, so it is the safe pick
    // even though the wider rule has the better priority.
    const rules = [
      rule({ ruleId: "lr_type", matchKind: "issuetype", matchValue: "Hata", flowType: "gelistirme", priority: 1 }),
      rule({ ruleId: "lr_status", matchKind: "status", matchValue: "Yapılacak", flowType: "analiz", priority: 90 }),
    ];
    const decision = flowDecisionFor(rules, ticket({ issueType: "Hata", status: "Yapılacak" }), null);

    expect(decision.flow).toBe("analiz");
    expect(decision.reason).toBe("rule_conflict");
    expect(decision.ruleId).toBe("lr_status");
    expect([...(decision.conflictingRuleIds ?? [])].sort()).toEqual(["lr_status", "lr_type"]);
  });

  it("prefers duzeltme over gelistirme when those two conflict", () => {
    const rules = [
      rule({ ruleId: "lr_a", matchKind: "issuetype", matchValue: "Hata", flowType: "gelistirme", priority: 1 }),
      rule({ ruleId: "lr_b", matchKind: "status", matchValue: "Yapılacak", flowType: "duzeltme", priority: 2 }),
    ];
    const decision = flowDecisionFor(rules, ticket({ issueType: "Hata", status: "Yapılacak" }), null);
    expect(decision.flow).toBe("duzeltme");
    expect(decision.reason).toBe("rule_conflict");
  });

  it("does NOT report a conflict when both matching rules name the same flow", () => {
    const rules = [
      rule({ ruleId: "lr_a", matchKind: "issuetype", matchValue: "Hata", flowType: "analiz", priority: 1 }),
      rule({ ruleId: "lr_b", matchKind: "status", matchValue: "Yapılacak", flowType: "analiz", priority: 2 }),
    ];
    const decision = flowDecisionFor(rules, ticket({ issueType: "Hata", status: "Yapılacak" }), null);
    expect(decision.reason).toBe("rule");
    expect(decision.conflictingRuleIds).toBeUndefined();
  });

  it("decides the same way whatever order the store returned the rows in", () => {
    // Determinism: the flow travels into the workflow input, so the same rule
    // set must always produce the same answer.
    const rules = [
      rule({ ruleId: "lr_b", matchValue: "Hata", flowType: "duzeltme", priority: 10 }),
      rule({ ruleId: "lr_a", matchValue: "Hata", flowType: "duzeltme", priority: 10 }),
    ];
    const forward = flowDecisionFor(rules, ticket({ issueType: "Hata" }), null);
    const reversed = flowDecisionFor([...rules].reverse(), ticket({ issueType: "Hata" }), null);
    expect(forward).toEqual(reversed);
    expect(forward.ruleId).toBe("lr_a");
  });
});

describe("rulesFor / ruleFor", () => {
  it("returns every matching rule, most important first", () => {
    const rules = [
      rule({ ruleId: "lr_2", matchValue: "Hata", priority: 20 }),
      rule({ ruleId: "lr_1", matchKind: "status", matchValue: "Yapılacak", priority: 10 }),
      rule({ ruleId: "lr_x", matchValue: "Görev", priority: 1 }),
    ];
    const matched = rulesFor(rules, ticket({ issueType: "Hata", status: "Yapılacak" }));
    expect(matched.map((r) => r.ruleId)).toEqual(["lr_1", "lr_2"]);
  });

  it("returns null when nothing matches", () => {
    expect(ruleFor([rule({ matchValue: "Hata" })], ticket({ issueType: "Görev" }))).toBeNull();
  });

  it("returns a COPY, so a caller cannot mutate the stored rule", () => {
    const rules = [rule({ matchValue: "Hata" })];
    const found = ruleFor(rules, ticket({ issueType: "Hata" }));
    found!.flowType = "gelistirme";
    expect(rules[0]!.flowType).toBe("duzeltme");
  });

  it("carries the rule's agent-variant mapping through", () => {
    const rules = [rule({ matchValue: "Hata", analystVariantId: "analist-v2", engineerVariantId: "kodcu-v1" })];
    const found = ruleFor(rules, ticket({ issueType: "Hata" }));
    expect(found?.analystVariantId).toBe("analist-v2");
    expect(found?.engineerVariantId).toBe("kodcu-v1");
  });
});

/**
 * The status map travels with the flow, out of the same rule row and in the
 * same decision.
 *
 * It has to be one read and one answer: "which flow does this ticket run" and
 * "which columns does it move through" are both properties of the rule that
 * matched, and asking for them separately would let a rule edit between the two
 * reads give a ticket one rule's flow and another rule's board.
 */
describe("flowDecisionFor — the deciding rule's status map", () => {
  const MAP = { onStart: "Devam Ediyor", onReview: "İNCELEMEDE", onDone: "Tamam" } as const;

  it("carries the winning rule's map into the decision", () => {
    const rules = [rule({ ruleId: "lr_map", matchValue: "Hata", statusMap: MAP })];
    expect(flowDecisionFor(rules, ticket({ issueType: "Hata" }), null).statusMap).toEqual(MAP);
  });

  it("answers null — comment-only mode — for a rule that maps nothing", () => {
    const rules = [rule({ ruleId: "lr_bare", matchValue: "Hata" })];
    expect(flowDecisionFor(rules, ticket({ issueType: "Hata" }), null).statusMap).toBeNull();
  });

  /**
   * A ticket that matched NO rule has no operator-configured board, and the
   * deployment default names a flow but never a column set. Inventing one would
   * mean every unclassified ticket in the bank started being driven around
   * somebody's Jira uninvited.
   */
  it("leaves the map absent when the deployment default decided", () => {
    const decision = flowDecisionFor([rule({ matchValue: "Hata" })], ticket({ issueType: "Görev" }), "analiz");
    expect(decision.reason).toBe("default");
    expect(decision.statusMap).toBeUndefined();
  });

  it("leaves the map absent when nothing decided at all", () => {
    const decision = flowDecisionFor([], ticket({ issueType: "Hata" }), null);
    expect(decision.reason).toBe("none");
    expect(decision.statusMap).toBeUndefined();
  });

  /**
   * Under a conflict the map comes from the rule that WON the flow, never
   * merged across the matching set: a merged map would drive the ticket to a
   * column no single rule asked for, which is a board move nobody configured
   * and nobody can explain afterwards.
   */
  it("takes the map from the rule that won a conflict, unmerged", () => {
    const rules = [
      rule({ ruleId: "lr_fix", matchKind: "issuetype", matchValue: "Hata", flowType: "duzeltme", priority: 1, statusMap: { onDone: "Bitti" } }),
      rule({ ruleId: "lr_an", matchKind: "status", matchValue: "Yapılacak", flowType: "analiz", priority: 2, statusMap: MAP }),
    ];
    const decision = flowDecisionFor(rules, ticket({ issueType: "Hata", status: "Yapılacak" }), null);
    // `analiz` is the narrowest flow, so `lr_an` decides — board included.
    expect(decision.reason).toBe("rule_conflict");
    expect(decision.ruleId).toBe("lr_an");
    expect(decision.statusMap).toEqual(MAP);
  });
});

/**
 * "Bota atanan her ticket" — `matchKind: "assigned"` (migration 0020).
 *
 * The rule that names no condition. Before it existed, the only way to say "if
 * a human hands this to the bot, work it" was to enumerate every issue type in
 * the project — which is a rule set that goes stale the day somebody adds a
 * type, and silently ignores the tickets carrying it.
 *
 * Two things make it safe to add. It compares NO field, so `matchValue` is a
 * placeholder nobody reads; and it is the LEAST SPECIFIC rule there is, so a
 * rule an operator wrote on purpose always beats it. The second is what stops
 * the catch-all from turning every deliberate rule in a project into a
 * `rule_conflict` the moment it is added.
 */
describe("flowDecisionFor — every ticket assigned to the bot", () => {
  const CATCH_ALL = rule({
    ruleId: "lr_any",
    matchKind: "assigned",
    // The literal the BFF pins. It must be irrelevant, and this is where that
    // is proved: no ticket below carries anything remotely like it.
    matchValue: "*",
    assigneeAccountId: "712020:bot",
    flowType: "analiz",
  });

  it("matches a ticket of any type and any status, so long as the bot has it", () => {
    for (const t of [
      ticket({ assignee: "712020:bot", issueType: "Görev" }),
      ticket({ assignee: "712020:bot", issueType: "Talep", status: "Onay Bekliyor" }),
      // The field the payload never delivered. A conditioned rule matches
      // nothing here (a null field matches nothing, deliberately); the
      // catch-all does not care, because it reads no field at all.
      ticket({ assignee: "712020:bot" }),
    ]) {
      const decision = flowDecisionFor([CATCH_ALL], t, null);
      expect(decision.reason).toBe("rule");
      expect(decision.ruleId).toBe("lr_any");
      expect(decision.flow).toBe("analiz");
    }
  });

  it("still respects the assignee — a ticket on a human is not Maestro's", () => {
    const decision = flowDecisionFor(
      [CATCH_ALL],
      ticket({ assignee: "712020:ayse", issueType: "Görev" }),
      null,
    );
    // Falls through to "no rule matched", not to the catch-all. The assignment
    // IS the condition; without it the rule says nothing about this ticket.
    expect(decision.reason).toBe("none");
  });

  it("loses to a rule that names a condition, with NO conflict reported", () => {
    const specific = rule({
      ruleId: "lr_bug",
      matchKind: "issuetype",
      matchValue: "Hata",
      assigneeAccountId: "712020:bot",
      flowType: "duzeltme",
      // Deliberately WORSE priority than the catch-all's default, to prove
      // specificity outranks priority rather than merely tie-breaking it.
      priority: 500,
    });
    const decision = flowDecisionFor(
      [CATCH_ALL, specific],
      ticket({ assignee: "712020:bot", issueType: "Hata" }),
      null,
    );

    expect(decision.flow).toBe("duzeltme");
    expect(decision.ruleId).toBe("lr_bug");
    // The headline: "Hata runs düzeltme, everything else assigned runs analiz"
    // is one coherent setup — the very setup the wizard produces — not a
    // misconfiguration to warn about on every single bug ticket.
    expect(decision.reason).toBe("rule");
    expect(decision.conflictingRuleIds).toBeUndefined();
  });

  it("catches the tickets the specific rule does not", () => {
    const specific = rule({
      ruleId: "lr_bug",
      matchValue: "Hata",
      assigneeAccountId: "712020:bot",
      flowType: "duzeltme",
    });
    const decision = flowDecisionFor(
      [CATCH_ALL, specific],
      ticket({ assignee: "712020:bot", issueType: "Görev" }),
      null,
    );
    expect(decision.ruleId).toBe("lr_any");
    expect(decision.flow).toBe("analiz");
  });

  it("carries its own status map, like any other deciding rule", () => {
    const mapped = { ...CATCH_ALL, statusMap: { onDone: "Tamam" } };
    const decision = flowDecisionFor([mapped], ticket({ assignee: "712020:bot" }), null);
    expect(decision.statusMap).toEqual({ onDone: "Tamam" });
  });

  it("still reports a real conflict between two catch-alls that disagree", () => {
    // The unique index stops this at the database for one (project, bot), but
    // two different bot accounts on one project can both match an unassigned-
    // agnostic rule — specificity must not swallow a genuine disagreement.
    const a = { ...CATCH_ALL, ruleId: "lr_a", assigneeAccountId: "", flowType: "analiz" as const };
    const b = { ...CATCH_ALL, ruleId: "lr_b", assigneeAccountId: "", flowType: "gelistirme" as const };
    const decision = flowDecisionFor([a, b], ticket({ assignee: "712020:bot" }), null);

    expect(decision.reason).toBe("rule_conflict");
    // Fail-closed, exactly as before: the narrowest flow of the matching set.
    expect(decision.flow).toBe("analiz");
    expect(decision.conflictingRuleIds).toEqual(["lr_a", "lr_b"]);
  });

  it("sorts the catch-all last in rulesFor, whatever its priority says", () => {
    const specific = rule({ ruleId: "lr_bug", matchValue: "Hata", assigneeAccountId: "712020:bot", priority: 900 });
    const matched = rulesFor(
      [CATCH_ALL, specific],
      ticket({ assignee: "712020:bot", issueType: "Hata" }),
    );
    expect(matched.map((r) => r.ruleId)).toEqual(["lr_bug", "lr_any"]);
    // `ruleFor` is the "first match wins" projection, so it follows.
    expect(ruleFor([CATCH_ALL, specific], ticket({ assignee: "712020:bot", issueType: "Hata" }))?.ruleId).toBe(
      "lr_bug",
    );
  });
});

/**
 * HANGİ AJAN — kuralın ajan seçimi, karara iliştirilmiş hâlde.
 *
 * Bu blok bir KOPUKLUĞU ölçüyor: `ListeningRule` sütunları vardı (0022), panel
 * yazıyordu, BFF okuyordu — ama karar buradan çıkarken ajan iğnesi düşüyor ve
 * `apps/deploy/src/bin/bff.ts` her koşuyu alfabetik olarak ilk analist
 * varyantına bağlıyordu. Yani kural ekranında ajan seçilebiliyor, seçim hiçbir
 * şeyi değiştirmiyordu.
 */
describe("flowDecisionFor — kararı veren kuralın ajan seçimi", () => {
  it("kazanan kuralın iki ajanını da karara taşır", () => {
    const rules = [
      rule({
        ruleId: "lr_ajanli",
        matchValue: "Hata",
        analystVariantId: "analyst-kredi",
        engineerVariantId: "engineer-dotnet",
      }),
    ];
    const decision = flowDecisionFor(rules, ticket({ issueType: "Hata" }), null);
    expect(decision.analystVariantId).toBe("analyst-kredi");
    expect(decision.engineerVariantId).toBe("engineer-dotnet");
  });

  it("ajanı yalnızca BİR tarafta seçen kural, diğerini varsayılana bırakır", () => {
    // Analiz akışı yazan bir kurul mühendis ajanı seçmeyebilir; bu bir eksik
    // değil, bir tercih — ve o taraf kurulum varsayılanına düşmeli.
    const rules = [rule({ matchValue: "Hata", analystVariantId: "analyst-kredi" })];
    const decision = flowDecisionFor(rules, ticket({ issueType: "Hata" }), null);
    expect(decision.analystVariantId).toBe("analyst-kredi");
    expect(decision.engineerVariantId).toBeUndefined();
  });

  /**
   * GERİYE DÖNÜK UYUM — bu paketin en önemli tek testi.
   *
   * Ajan seçimi bir DARALTMA'dır, bir kapı değil: seçmemiş her mevcut kural
   * bugüne kadar nasıl koşuyorsa öyle koşmalı. Alan `null` olarak DEĞİL, HİÇ
   * yazılmaz — yokluk, çağıran tarafta "kurulum varsayılanına düş" demek.
   */
  it("ajan seçmemiş kuralda iki alanı da HİÇ yazmaz", () => {
    const rules = [rule({ matchValue: "Hata" })];
    const decision = flowDecisionFor(rules, ticket({ issueType: "Hata" }), null);
    expect(decision.analystVariantId).toBeUndefined();
    expect(decision.engineerVariantId).toBeUndefined();
    expect("analystVariantId" in decision).toBe(false);
    expect("engineerVariantId" in decision).toBe(false);
  });

  it("boş ve yalnızca boşluktan oluşan seçimi 'seçilmedi' sayar", () => {
    // Panel bir seçimi kaldırdığında satırda "" mi `null` mü kaldığı bir
    // depolama ayrıntısı; koşuya boş bir varyant kimliği geçmek ise gateway
    // sözleşmesini ilk model çağrısında bozar.
    const rules = [rule({ matchValue: "Hata", analystVariantId: "", engineerVariantId: "   " })];
    const decision = flowDecisionFor(rules, ticket({ issueType: "Hata" }), null);
    expect(decision.analystVariantId).toBeUndefined();
    expect(decision.engineerVariantId).toBeUndefined();
  });

  it("hiçbir kural eşleşmediğinde ajan da seçilmez", () => {
    const byDefault = flowDecisionFor([rule({ matchValue: "Hata" })], ticket({ issueType: "Görev" }), "analiz");
    expect(byDefault.reason).toBe("default");
    expect(byDefault.analystVariantId).toBeUndefined();

    const none = flowDecisionFor([], ticket({ issueType: "Hata" }), null);
    expect(none.reason).toBe("none");
    expect(none.engineerVariantId).toBeUndefined();
  });

  /**
   * Çakışmada ajanlar da KAZANAN kuraldan, `statusMap` ile aynı gerekçeyle:
   * bir kuralın akışını başka bir kuralın ajanıyla koşturmak, çakışmayı
   * çözmek değil, üçüncü bir yapılandırma uydurmaktır.
   */
  it("çakışmayı kazanan kuralın ajanlarını alır, karıştırmaz", () => {
    const rules = [
      rule({
        ruleId: "lr_fix",
        matchKind: "issuetype",
        matchValue: "Hata",
        flowType: "duzeltme",
        priority: 1,
        analystVariantId: "analyst-yanlis",
        engineerVariantId: "engineer-yanlis",
      }),
      rule({
        ruleId: "lr_an",
        matchKind: "status",
        matchValue: "Yapılacak",
        flowType: "analiz",
        priority: 2,
        analystVariantId: "analyst-kredi",
      }),
    ];
    const decision = flowDecisionFor(rules, ticket({ issueType: "Hata", status: "Yapılacak" }), null);
    expect(decision.reason).toBe("rule_conflict");
    expect(decision.ruleId).toBe("lr_an");
    expect(decision.analystVariantId).toBe("analyst-kredi");
    // Kazanan kural mühendis seçmedi; kaybedenin seçimi devralınmaz.
    expect(decision.engineerVariantId).toBeUndefined();
  });
});

/**
 * STATÜ KAPISI — her kuralda, tetikleme tipinden BAĞIMSIZ (0024).
 *
 * Operatörün kendi cümlesi: "bota atanan her ticket seçsem de o statüde
 * atanıyor olmalı. Yani atanmış olsa da izin verdiğim analiz statüsünde
 * değilse, o olmadan çalışmamalı."
 *
 * Bu blok bu cümlenin testi. Öncesinde dört tetikleme tipi ALTERNATİFTİ:
 * `assigned` seçildiğinde statüye HİÇ bakılmıyordu, dolayısıyla bota atanmış
 * her ticket — panonun neresinde olursa olsun — işleniyordu. Bu, servis hesabı
 * ADMIN olan bir bankada her projedeki her atamanın analize girmesi demekti.
 */
describe("flowDecisionFor — statü kapısı her kuralda sorulur", () => {
  const BOT = "712020:bot";

  it("bota atanmış + DOĞRU statü → işlenir", () => {
    const rules = [
      rule({
        ruleId: "lr_atanan",
        matchKind: "assigned",
        matchValue: "*",
        assigneeAccountId: BOT,
        allowedStatuses: ["Analiz"],
        flowType: "analiz",
      }),
    ];
    const decision = flowDecisionFor(rules, ticket({ assignee: BOT, status: "Analiz" }), null);
    expect(decision.reason).toBe("rule");
    expect(decision.ruleId).toBe("lr_atanan");
    expect(decision.flow).toBe("analiz");
  });

  /**
   * KULLANICININ ASIL İSTEDİĞİ TEST.
   *
   * Ticket bota ATANMIŞ ve tetikleme tipi tam da "bota atanan her ticket" —
   * yani 0024 öncesi bu kural KESİNLİKLE eşleşirdi. Statü izin verilenler
   * arasında olmadığı için artık eşleşmiyor.
   */
  it("bota atanmış + YANLIŞ statü → İŞLENMEZ", () => {
    const rules = [
      rule({
        ruleId: "lr_atanan",
        matchKind: "assigned",
        matchValue: "*",
        assigneeAccountId: BOT,
        allowedStatuses: ["Analiz"],
        flowType: "analiz",
      }),
    ];
    const decision = flowDecisionFor(rules, ticket({ assignee: BOT, status: "Tamam" }), null);
    // Hiçbir kural eşleşmedi: kurulum varsayılanı yok, akış seçilmedi.
    expect(decision.reason).toBe("none");
    expect(decision.ruleId).toBeUndefined();
    expect(rulesFor(rules, ticket({ assignee: BOT, status: "Tamam" }))).toEqual([]);
  });

  it("statü kapısı ISSUETYPE kuralında da sorulur — tetikleme tipinden bağımsız", () => {
    const rules = [
      rule({
        ruleId: "lr_hata",
        matchKind: "issuetype",
        matchValue: "Hata",
        assigneeAccountId: BOT,
        allowedStatuses: ["Yapılacak"],
      }),
    ];
    // Tip tutuyor, statü tutmuyor: 0024 öncesi eşleşirdi.
    expect(rulesFor(rules, ticket({ assignee: BOT, issueType: "Hata", status: "Tamam" }))).toEqual(
      [],
    );
    // Aynı ticket, izin verilen statüde: eşleşir.
    const ok = flowDecisionFor(
      rules,
      ticket({ assignee: BOT, issueType: "Hata", status: "Yapılacak" }),
      null,
    );
    expect(ok.ruleId).toBe("lr_hata");
  });

  it("statü kapısı ETİKET kuralında da sorulur", () => {
    const rules = [
      rule({
        ruleId: "lr_etiket",
        matchKind: "label",
        matchValue: "maestro",
        assigneeAccountId: BOT,
        allowedStatuses: ["Yapılacak"],
      }),
    ];
    expect(
      rulesFor(rules, ticket({ assignee: BOT, labels: ["maestro"], status: "Tamam" })),
    ).toEqual([]);
  });

  it("birden çok izinli statüden HERHANGİ biri yeterlidir", () => {
    const rules = [
      rule({
        ruleId: "lr_coklu",
        matchKind: "assigned",
        matchValue: "*",
        assigneeAccountId: BOT,
        allowedStatuses: ["Yapılacaklar", "Analiz Bekliyor"],
        flowType: "analiz",
      }),
    ];
    for (const status of ["Yapılacaklar", "Analiz Bekliyor"]) {
      expect(flowDecisionFor(rules, ticket({ assignee: BOT, status }), null).ruleId).toBe(
        "lr_coklu",
      );
    }
    expect(rulesFor(rules, ticket({ assignee: BOT, status: "Devam Ediyor" }))).toEqual([]);
  });

  /**
   * BİLİNMEYEN STATÜ KAPALI SAYILIR — kapının fail-closed yönü.
   *
   * Statüsü okunmamış bir ticket'ı statü-kısıtlı bir kuralla işlemek, tam
   * olarak kapının engellemek için var olduğu şeyi yapmak olurdu.
   */
  it("statüsü OKUNMAMIŞ ticket, statü kısıtı olan kuralla eşleşmez", () => {
    const rules = [
      rule({
        ruleId: "lr_atanan",
        matchKind: "assigned",
        matchValue: "*",
        assigneeAccountId: BOT,
        allowedStatuses: ["Analiz"],
      }),
    ];
    expect(rulesFor(rules, ticket({ assignee: BOT, status: null }))).toEqual([]);
  });

  /**
   * MEVCUT KURALLAR: statü kısıtı olmayan kural ÇALIŞIR.
   *
   * 0024 öncesi yazılmış her satır bu durumda. Fail-closed backfill bankanın
   * bugün çalışan her kuralını, kimse hiçbir şey değiştirmeden, sessizce
   * durdururdu. Çalışırlar — ama `statusGateOf` bu durumu ADLANDIRIR ve panel,
   * karar dökümü ve tarama günlüğü aynı adı okur; sessiz bir fail-open değil.
   */
  it("statü kısıtı OLMAYAN mevcut kural aynen çalışır (geriye dönük uyumluluk)", () => {
    for (const allowedStatuses of [undefined, null, []] as const) {
      const rules = [
        rule({
          ruleId: "lr_eski",
          matchKind: "assigned",
          matchValue: "*",
          assigneeAccountId: BOT,
          flowType: "analiz",
          ...(allowedStatuses === undefined ? {} : { allowedStatuses }),
        }),
      ];
      const decision = flowDecisionFor(rules, ticket({ assignee: BOT, status: "Tamam" }), null);
      expect(decision.ruleId, `allowedStatuses=${JSON.stringify(allowedStatuses)}`).toBe("lr_eski");
    }
  });

  it("statü kısıtsız kuralı GÖRÜNÜR kılar — sessiz fail-open değil", () => {
    const ungated = rule({ ruleId: "lr_eski", matchKind: "assigned", matchValue: "*" });
    const gated = rule({ ruleId: "lr_yeni", allowedStatuses: ["Analiz"] });
    expect(statusGateOf(ungated, "Tamam")).toBe("ungated");
    expect(statusGateOf(gated, "Analiz")).toBe("open");
    expect(statusGateOf(gated, "Tamam")).toBe("closed");
    expect(statusGateOf(gated, null)).toBe("unknown_status");
  });

  /**
   * SAHADA GÖRÜLDÜ: takım yönetimli projede `status in ("Yapılacaklar")` sıfır
   * döner, `status in (10004)` bir — panel bu yüzden kapıya İD yazıyor. Kapı
   * yalnız ADI karşılaştırdığı sürece tarama ticket'ı BULUYOR, kapı ELİYOR
   * ("1 ticket bulundu, 0'ı kurala düştü"). `matchValue` için uygulanan
   * kuralın aynısı burada da geçerli.
   */
  it("kapı İD ile de açılır — takım yönetimli projede ad çalışmıyor", () => {
    const byId = rule({ allowedStatuses: ["10004"] });
    expect(statusGateOf(byId, "Yapılacaklar", "10004")).toBe("open");
    // İd tutan bir kural, ADI aynı olsa bile id tutmayan bir ticket'ı açmaz.
    expect(statusGateOf(byId, "Yapılacaklar", "10009")).toBe("closed");
    expect(statusGateOf(byId, "Yapılacaklar")).toBe("closed");
  });

  it("ad tutan kural ID'siz ticket'ta da çalışır — mevcut kurulumlar bozulmaz", () => {
    const byName = rule({ allowedStatuses: ["Analiz"] });
    expect(statusGateOf(byName, "Analiz")).toBe("open");
    expect(statusGateOf(byName, "Analiz", "10004")).toBe("open");
    expect(statusGateOf(byName, "Tamam", "10004")).toBe("closed");
  });

  it("statüsü hiç okunmamış ticket kapalıdır — id de yoksa", () => {
    const byId = rule({ allowedStatuses: ["10004"] });
    expect(statusGateOf(byId, null, null)).toBe("unknown_status");
    // Ama YALNIZ id okunmuşsa kapı kararını verebilir.
    expect(statusGateOf(byId, null, "10004")).toBe("open");
  });

  it("statü karşılaştırması baştaki/sondaki boşluğa takılmaz", () => {
    const gated = rule({ allowedStatuses: ["  Analiz  "] });
    expect(statusGateOf(gated, "Analiz")).toBe("open");
    expect(statusGateOf(gated, " Analiz ")).toBe("open");
  });
});

/**
 * TAKIM YÖNETİMLİ (next-gen) PROJE — kuralın İD tuttuğu hâl.
 *
 * ── CANLI ÖLÇÜM ─────────────────────────────────────────────────────────────
 * Bağlı OPS projesi `style: "next-gen"` ve orada JQL adları çözmüyor:
 *
 *     issuetype = "Görev"        → 0 ticket      issuetype = 10008 → 14
 *     status in ("Yapılacaklar") → 0 ticket      status = 10004    → 12
 *
 * `jqlFor` bu yüzden sayısal değeri tırnaksız yazıyor ve panel o projede
 * kurala İD kaydediyor. Eşleşme ADI karşılaştırsaydı sorgu ticket'ı BULUR,
 * `matches()` hepsini ELERDİ (`"Görev" === "10008"`) — arıza "hiç bulunmuyor"
 * dan "bulunuyor ama işlenmiyor"a taşınırdı, ikisi de sessiz.
 */
describe("flowDecisionFor — takım yönetimli projede kural İD tutar", () => {
  it("sayısal kural, İD taşıyan ticket'ı eşleştirir", () => {
    const rules = [rule({ ruleId: "lr_id", matchKind: "issuetype", matchValue: "10008" })];
    const decision = flowDecisionFor(
      rules,
      ticket({ issueType: "Görev", issueTypeId: "10008" }),
      null,
    );
    expect(decision.reason).toBe("rule");
    expect(decision.ruleId).toBe("lr_id");
  });

  it("statü kuralı da İD ile eşleşir", () => {
    const rules = [rule({ ruleId: "lr_st", matchKind: "status", matchValue: "10004" })];
    const decision = flowDecisionFor(
      rules,
      ticket({ status: "Yapılacaklar", statusId: "10004" }),
      null,
    );
    expect(decision.ruleId).toBe("lr_st");
  });

  /**
   * ARIZANIN TA KENDİSİ: kural id tutuyor, ticket id taşımıyor.
   *
   * Üretici uçlar kimliği doldurmadan önceki hâl. Eşleşme OLMAMALI — ama
   * "olmasın" derken sebebi doğru olmalı: ada düşülüp `"Görev" === "10008"`
   * karşılaştırılması da aynı sonucu verirdi, o yüzden ticket'ın ADI kuralın
   * beklediği tipin adı ve yine de eşleşmiyor.
   */
  it("sayısal kural, İD TAŞIMAYAN ticket'ı eşleştirmez — ada DÜŞMEZ", () => {
    const rules = [rule({ ruleId: "lr_id", matchKind: "issuetype", matchValue: "10008" })];
    expect(flowDecisionFor(rules, ticket({ issueType: "Görev" }), null).reason).toBe("none");
    expect(
      flowDecisionFor(rules, ticket({ issueType: "Görev", issueTypeId: null }), null).reason,
    ).toBe("none");
  });

  it("sayısal kural, BAŞKA bir İD taşıyan ticket'ı eşleştirmez", () => {
    const rules = [rule({ matchKind: "issuetype", matchValue: "10008" })];
    expect(
      flowDecisionFor(rules, ticket({ issueType: "Görev", issueTypeId: "10001" }), null).reason,
    ).toBe("none");
  });

  /**
   * REGRESYON: şirket yönetimli projede hiçbir şey değişmedi.
   *
   * Kimliği taşıyan ama kuralı ADLA yazılmış bir ticket, kimlik alanları
   * eklenmeden önce nasıl eşleşiyorsa öyle eşleşmeye devam eder — ve id'yi hiç
   * okumamış bir çağıran için de aynısı geçerli.
   */
  it("adlı kural, adla eşleşmeye devam eder — İD taşınsın taşınmasın", () => {
    const rules = [rule({ ruleId: "lr_ad", matchKind: "issuetype", matchValue: "Hata" })];
    expect(flowDecisionFor(rules, ticket({ issueType: "Hata" }), null).ruleId).toBe("lr_ad");
    expect(
      flowDecisionFor(rules, ticket({ issueType: "Hata", issueTypeId: "10008" }), null).ruleId,
    ).toBe("lr_ad");
  });

  /**
   * Kimlik karşılaştırması KENDİ alanına bakar: bir `status` kuralı tip
   * kimliğine, bir `issuetype` kuralı statü kimliğine bakmaz. İkisi de sayı
   * olduğu için bu karışma sessiz ve tam da bu yüzden yazılıyor.
   */
  it("statü kuralı TİP kimliğiyle, tip kuralı STATÜ kimliğiyle eşleşmez", () => {
    const statusRule = [rule({ matchKind: "status", matchValue: "10008" })];
    expect(
      flowDecisionFor(statusRule, ticket({ issueTypeId: "10008", status: "Yapılacaklar" }), null)
        .reason,
    ).toBe("none");

    const typeRule = [rule({ matchKind: "issuetype", matchValue: "10004" })];
    expect(
      flowDecisionFor(typeRule, ticket({ statusId: "10004", issueType: "Görev" }), null).reason,
    ).toBe("none");
  });
});
