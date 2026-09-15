import { describe, expect, it } from "vitest";
import { BODY_LIMIT_BYTES } from "../src/server.js";
import { FakeWorkPort, WEBHOOK_SECRET } from "./fakes.js";
import { auth, harness, UGURPAY_BINDING } from "./helpers.js";
import { commentEvent, issueEvent, signed } from "./payloads.js";
import type { ListeningRuleRecord } from "../src/listening-store.js";

/**
 * BU DOSYADAKİ TESTLER WEBHOOK YOLUNU ÖLÇÜYOR, akış/depo kararını değil.
 *
 * Kuralsız bir harness'ta ticket artık koşu açamıyor: hiçbir kural eşleşmeyince
 * akış belirsiz kalır, belirsiz akış "tam boru hattı" sayılır (kod yazar,
 * uygulama ister), ve proje bağlamasının depo varsayılanı zincirden çıkarıldığı
 * için uygulama gelmez. O halka sessiz bir varsayılandı — eşleme cevap
 * veremediğinde devreye giriyor ve operatöre eşlemenin çalıştığını sandırıyordu.
 *
 * Bu yardımcı, gerçek bir kurulumun `seed-defaults` sonrası hâlini kuruyor:
 * bota atanmış her ticket'ı alan geniş bir `analiz` kuralı. `analiz` çünkü depo
 * istemeyen tek akış odur. Böylece testler ölçmek istedikleri şeye — imza
 * doğrulama, tekrar teslimat, etiket kapısı — odaklanabiliyor.
 */
const CATCH_ALL: ListeningRuleRecord = {
  ruleId: "lr_catch_all",
  projectKey: "UGURPAY",
  assigneeAccountId: "",
  matchKind: "assigned",
  matchValue: "*",
  flowType: "analiz",
  priority: 1000,
  enabled: true,
  analystVariantId: null,
  engineerVariantId: null,
  /**
   * Depo KURALIN eşlemesinden gelir; bu, bağlamanın eski varsayılanının
   * açıkça yazılmış hâli. `analiz` akışı depo İSTEMEZ ama testler koşunun
   * `appId`ini ölçüyor, ve gerçek bir kurulumda analiz kuralı da bir depoya
   * bağlanabilir (kod okuyarak zenginleşir).
   */
  repoMap: { field: "*", entries: [{ value: "*", appId: "ugurpay" }] },
};

/** `harness()` ama varsayılan olarak yakalayıcı kuralla. */
const webhookHarness: typeof harness = (options = {}) =>
  harness({ listeningRules: [CATCH_ALL], ...options });

describe("POST /webhooks/jira", () => {
  it("refuses a delivery with no signature (M15 fail-closed)", async () => {
    const h = await webhookHarness();
    const response = await h.app.inject({
      method: "POST",
      url: "/webhooks/jira",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify(issueEvent({ ticket: "UGURPAY-1" })),
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "webhook_unauthenticated" });
    expect(h.runs.started).toHaveLength(0);
  });

  it("refuses a delivery whose signature belongs to another secret", async () => {
    const h = await webhookHarness();
    const delivery = signed(issueEvent({ ticket: "UGURPAY-1" }), "someone-elses-secret");
    const response = await h.app.inject({
      method: "POST",
      url: "/webhooks/jira",
      headers: delivery.headers,
      payload: delivery.payload,
    });

    expect(response.statusCode).toBe(401);
    expect(h.runs.started).toHaveLength(0);
  });

  it("refuses a body that was re-serialised after signing", async () => {
    const h = await webhookHarness();
    const delivery = signed(issueEvent({ ticket: "UGURPAY-1" }));

    // Same JSON value, different bytes: key order and spacing changed. This is
    // exactly what a framework that parses before verifying would hand on, and
    // it must not verify.
    const reserialized = JSON.stringify(JSON.parse(delivery.payload), null, 2);
    expect(reserialized).not.toBe(delivery.payload);

    const response = await h.app.inject({
      method: "POST",
      url: "/webhooks/jira",
      headers: delivery.headers,
      payload: reserialized,
    });

    expect(response.statusCode).toBe(401);
    expect(h.runs.started).toHaveLength(0);
  });

  it("answers 401, not 400, when an unsigned body is also malformed", async () => {
    const h = await webhookHarness();
    const response = await h.app.inject({
      method: "POST",
      url: "/webhooks/jira",
      headers: { "content-type": "application/json" },
      payload: "{ this is not json",
    });

    expect(response.statusCode).toBe(401);
  });

  it("starts a run for a signed issue event on a bound project", async () => {
    const h = await webhookHarness();
    const delivery = signed(issueEvent({ ticket: "UGURPAY-42" }));

    const response = await h.app.inject({
      method: "POST",
      url: "/webhooks/jira",
      headers: delivery.headers,
      payload: delivery.payload,
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ accepted: true, started: true });
    expect(h.runs.started).toHaveLength(1);
    expect(h.runs.started[0]).toMatchObject({ ticket: "UGURPAY-42", appId: "ugurpay" });

    const events = await h.auditStore.read();
    expect(events.map((event) => event.action)).toContain("RUN_STARTED");
  });

  it("does not start a second run when the same ticket is delivered twice", async () => {
    const h = await webhookHarness();
    const delivery = signed(issueEvent({ ticket: "UGURPAY-42" }));
    const send = () =>
      h.app.inject({
        method: "POST",
        url: "/webhooks/jira",
        headers: delivery.headers,
        payload: delivery.payload,
      });

    await send();
    const second = await send();

    expect(second.json()).toMatchObject({ accepted: true, started: false });
    const events = await h.auditStore.read();
    expect(events.filter((event) => event.action === "RUN_STARTED")).toHaveLength(1);
  });

  it("drops a project that was never bound, silently but counted (M102)", async () => {
    const h = await webhookHarness({ bindings: [] });
    const delivery = signed(issueEvent({ ticket: "UGURWEB-9" }));

    const response = await h.app.inject({
      method: "POST",
      url: "/webhooks/jira",
      headers: delivery.headers,
      payload: delivery.payload,
    });

    expect(response.json()).toEqual({ accepted: false, reason: "unbound" });
    expect(h.app.maestro.counters.droppedUnbound).toBe(1);
    expect(h.work.comments).toHaveLength(0);
  });

  /**
   * M48a'NIN PROJE SEVİYESİNDEKİ OPT-IN ETİKET KAPISI ARTIK YOK (0023).
   *
   * Eskiden burada şu vardı: `triggerMode: "opt_in"` bir projede, `maestro`
   * etiketi taşımayan ticket `not_opted_in` ile reddedilir, dinleme kuralları
   * HİÇ okunmazdı. Kapı, ölçülen bir sebeple kalktı: tarama yolu
   * (`jira-discovery.ts`) `explicit: true` geçip onu ATLIYOR, webhook yolu
   * atlamıyordu — yani operatörün kuralına tam uyan AYNI ticket, tarama turunda
   * alınıp webhook teslimatında sessizce düşüyordu. Tetikleme iki ayrı yerde
   * tanımlıydı ve ikisi birbirini bilmiyordu.
   *
   * Test SİLİNMEDİ, TERSİNE ÇEVRİLDİ. Bir davranışın kalktığını yalnızca onu
   * bekleyen testi silerek anlatmak, aynı kapının bir sonraki turda farkında
   * olunmadan geri gelmesine açık kapı bırakır — bu satır kapının gittiğini
   * SÖYLEYEN şeydir.
   */
  /**
   * BAĞLI OLMAYAN PROJE, BOTA ATANMIŞ VE STATÜSÜ UYGUN OLSA BİLE İŞLENMEZ.
   *
   * Opt-in etiket kapısı 0023'te kalktı; BAĞLANTI kapısı kalkmadı ve kalkmamalı.
   * İkisi aynı şey değildir: etiket "bu ticket'ı istiyor musun?" diye sorardı,
   * bağlantı "bu PROJE sana verildi mi?" diye sorar — ve bu kurulumun Jira
   * servis hesabı rutin olarak ADMIN'dir, yani bağlanmamış bir proje kapsam
   * dışı bir proje değil, Maestro'yu hiç duymamış bir ekibin ticket'larıdır.
   *
   * Bu test, tetiklemeyi tek yere toplarken o kapının yanlışlıkla gevşetilmiş
   * olmadığını sabitliyor — kuralın eşleşeceği HER ŞEY (bota atanma, statü,
   * etiket) yerinde olduğu hâlde ticket işlenmemeli. `h.work.comments`
   * üzerinden de bakılıyor: bağlanmamış bir projeye yorum yazmak, koşu
   * başlatmaktan daha görünür bir sınır ihlalidir.
   */
  it("refuses an unbound project even when the bot is assigned and a rule would match", async () => {
    const h = await harness({
      bindings: [],
      listeningRules: [
        {
          ruleId: "lr_status",
          projectKey: "UGURPAY",
          assigneeAccountId: "",
          matchKind: "status",
          matchValue: "Analiz Bekliyor",
          flowType: "analiz",
          priority: 100,
          enabled: true,
          analystVariantId: null,
          engineerVariantId: null,
          statusMap: null,
        },
      ],
    });
    const delivery = signed(
      issueEvent({ ticket: "UGURPAY-7", status: "Analiz Bekliyor", labels: ["maestro"] }),
    );

    const response = await h.app.inject({
      method: "POST",
      url: "/webhooks/jira",
      headers: delivery.headers,
      payload: delivery.payload,
    });

    expect(response.json()).toEqual({ accepted: false, reason: "unbound" });
    expect(h.runs.started).toHaveLength(0);
    expect(h.work.comments).toHaveLength(0);
  });

  it("no longer refuses an unlabelled ticket: the project-wide opt-in gate is gone (0023)", async () => {
    const h = await webhookHarness({
      bindings: [{ ...UGURPAY_BINDING, triggerMode: "opt_in" }],
    });
    const delivery = signed(issueEvent({ ticket: "UGURPAY-7" }));

    const response = await h.app.inject({
      method: "POST",
      url: "/webhooks/jira",
      headers: delivery.headers,
      payload: delivery.payload,
    });

    expect(response.json()).toMatchObject({ accepted: true });
    expect(h.runs.started).toHaveLength(1);
  });

  it("takes a labelled ticket just the same — the label is no longer a gate", async () => {
    const h = await webhookHarness({
      bindings: [{ ...UGURPAY_BINDING, triggerMode: "opt_in" }],
    });
    const delivery = signed(issueEvent({ ticket: "UGURPAY-7", labels: ["maestro"] }));

    const response = await h.app.inject({
      method: "POST",
      url: "/webhooks/jira",
      headers: delivery.headers,
      payload: delivery.payload,
    });

    expect(response.json()).toMatchObject({ accepted: true });
  });

  /**
   * ETİKET ARTIK BİR TETİKLEME TİPİ — ve webhook yolunda gerçekten çalışıyor.
   *
   * Kapıyı kaldırmak etiketi işlevsiz bırakmadı, YERİNİ DEĞİŞTİRDİ: etiketle
   * tetiklemek isteyen operatör bunu kuralda söyler (`matchKind: "label"`), ve
   * o kural ticket'ın AKIŞINI seçer. Bu iki test o yer değişikliğinin iki
   * yönünü kilitliyor: etiketi taşıyan ticket kuralın akışını alır, taşımayan
   * almaz — reddedilmez (kapı yok), kuralın akışını almaz (kural eşleşmez).
   */
  it("a label RULE picks the flow for a ticket carrying that label", async () => {
    const h = await harness({
      listeningRules: [
        {
          ruleId: "lr_label",
          projectKey: "UGURPAY",
          // Boş: "kime atandığına bakma". Bu testin konusu etiket eşleşmesi.
          assigneeAccountId: "",
          matchKind: "label",
          matchValue: "maestro",
          flowType: "duzeltme",
          // Kod yazan akış deposunu kendi eşlemesinden alır (bağlama varsayılanı kalktı).
          repoMap: { field: "*", entries: [{ value: "*", appId: "ugurpay" }] },
          priority: 100,
          enabled: true,
          analystVariantId: null,
          engineerVariantId: null,
          statusMap: null,
        },
      ],
    });
    const delivery = signed(issueEvent({ ticket: "UGURPAY-7", labels: ["digeri", "maestro"] }));

    const response = await h.app.inject({
      method: "POST",
      url: "/webhooks/jira",
      headers: delivery.headers,
      payload: delivery.payload,
    });

    expect(response.json()).toMatchObject({ accepted: true });
    // Kararın kendisi denetim zincirinde: hangi kural, hangi akış.
    const started = (await h.auditStore.read()).find((e) => e.action === "RUN_STARTED");
    expect(started?.meta).toMatchObject({ flow: "duzeltme", flowReason: "rule", flowRuleId: "lr_label" });
  });

  it("a label rule does not claim a ticket without that label", async () => {
    const h = await harness({
      listeningRules: [
        {
          ruleId: "lr_label",
          projectKey: "UGURPAY",
          assigneeAccountId: "",
          matchKind: "label",
          matchValue: "maestro",
          flowType: "duzeltme",
          // Kod yazan akış deposunu kendi eşlemesinden alır (bağlama varsayılanı kalktı).
          repoMap: { field: "*", entries: [{ value: "*", appId: "ugurpay" }] },
          priority: 100,
          enabled: true,
          analystVariantId: null,
          engineerVariantId: null,
          statusMap: null,
        },
        // Etiketi tutmayan ticket'ın yine de bir koşu açabilmesi için: asıl
        // iddia `lr_label`ın KARAR VERMEMESİ, koşunun hiç açılmaması değil.
        CATCH_ALL,
      ],
    });
    const delivery = signed(issueEvent({ ticket: "UGURPAY-7", labels: ["digeri"] }));

    const response = await h.app.inject({
      method: "POST",
      url: "/webhooks/jira",
      headers: delivery.headers,
      payload: delivery.payload,
    });

    // Alınır (kapı yok) ama kuralın akışıyla değil — kural eşleşmedi.
    expect(response.json()).toMatchObject({ accepted: true });
    const started = (await h.auditStore.read()).find((e) => e.action === "RUN_STARTED");
    expect(started?.meta).not.toMatchObject({ flowRuleId: "lr_label" });
  });

  it("sends a ticket with no application to the assignment queue (M99 tier 3)", async () => {
    /*
     * "Uygulama yok" hâli artık BAĞLAMADAN değil, kuralın eşlemesinden gelir:
     * `binding.appId` zincirden çıkarıldı (sessiz bir varsayılandı). Eşlemesiz
     * bir kod akışı kuralı aynı sonucu verir — ticket atama kuyruğuna gider.
     */
    const h = await harness({
      listeningRules: [{ ...CATCH_ALL, flowType: "gelistirme", repoMap: null }],
    });
    const delivery = signed(issueEvent({ ticket: "UGURPAY-8" }));

    const response = await h.app.inject({
      method: "POST",
      url: "/webhooks/jira",
      headers: delivery.headers,
      payload: delivery.payload,
    });

    expect(response.json()).toEqual({ accepted: false, reason: "no_application" });
    expect(h.runs.started).toHaveLength(0);
    expect(h.work.lastComment("UGURPAY-8")).toContain("UGURPAY-8");
  });

  it("counts but cannot explain an invalid command when the driver offers no diagnosis", async () => {
    const work = new FakeWorkPort();
    // A WorkPort that implements only the frozen interface: no
    // `parseCommandDetailed`, so the BFF has nothing to say back.
    Object.defineProperty(work, "parseCommandDetailed", { value: undefined });
    const h = await webhookHarness({ deps: { work } });

    const delivery = signed(
      commentEvent({ ticket: "UGURPAY-3", author: "mert.demir", body: "/onayla" }),
    );
    const response = await h.app.inject({
      method: "POST",
      url: "/webhooks/jira",
      headers: delivery.headers,
      payload: delivery.payload,
    });

    expect(h.app.maestro.diagnostics).toBeNull();
    expect(response.json()).toEqual({ accepted: false, reason: "not_intake" });
    expect(work.comments).toHaveLength(0);
  });

  it("ignores a comment that is not a command", async () => {
    const h = await webhookHarness();
    const delivery = signed(
      commentEvent({ ticket: "UGURPAY-3", author: "mert.demir", body: "bir bakayım" }),
    );

    const response = await h.app.inject({
      method: "POST",
      url: "/webhooks/jira",
      headers: delivery.headers,
      payload: delivery.payload,
    });

    expect(response.json()).toEqual({ accepted: false, reason: "not_intake" });
    expect(h.work.comments).toHaveLength(0);
  });
});

/**
 * The body limit is a deliberate number, not whatever the framework happens to
 * default to. Jira tickets carry long Turkish descriptions and pasted logs, and
 * a real delivery that silently exceeds an accidental 1 MB would look like an
 * outage nobody configured.
 */
describe("request body limit", () => {
  /** A signed delivery whose comment body is `size` bytes of filler. */
  function bulkyDelivery(size: number) {
    return signed(
      commentEvent({ ticket: "UGURPAY-4", author: "mert.demir", body: "a".repeat(size) }),
    );
  }

  it("accepts a delivery larger than Fastify's 1 MB default", async () => {
    const h = await webhookHarness();
    const delivery = bulkyDelivery(2 * 1024 * 1024);

    const response = await h.app.inject({
      method: "POST",
      url: "/webhooks/jira",
      headers: delivery.headers,
      payload: delivery.payload,
    });

    expect(response.statusCode).toBe(202);
  });

  it("refuses a delivery past the configured limit, and does not 500", async () => {
    const h = await webhookHarness();
    const delivery = bulkyDelivery(BODY_LIMIT_BYTES + 1024);

    const response = await h.app.inject({
      method: "POST",
      url: "/webhooks/jira",
      headers: delivery.headers,
      payload: delivery.payload,
    });

    expect(response.statusCode).toBe(413);
  });

  it("applies the same limit to the REST surface", async () => {
    const h = await webhookHarness();
    await h.addUser({ username: "ayse.kaya", roles: ["admin"] });
    const token = await h.login("ayse.kaya");

    const response = await h.app.inject({
      method: "PUT",
      url: "/params/reminder.channel",
      headers: { ...auth(token), "content-type": "application/json" },
      payload: JSON.stringify({ value: "a".repeat(BODY_LIMIT_BYTES + 1024) }),
    });

    expect(response.statusCode).toBe(413);
  });

  it("is an explicit number rather than an inherited default", () => {
    expect(BODY_LIMIT_BYTES).toBeGreaterThan(1024 * 1024);
  });
});

describe("silent webhook outcomes leave a server-side trace (denetim B5)", () => {
  /** A harness whose fastify logger writes into an assertable buffer. */
  async function loggedHarness(options: Parameters<typeof harness>[0] = {}) {
    const raw: string[] = [];
    const h = await harness({
      listeningRules: [CATCH_ALL],
      ...options,
      fastify: {
        logger: {
          level: "warn",
          stream: {
            write: (line: string) => {
              raw.push(line);
            },
          },
        },
      },
    });
    const lines = (msg: string): Array<Record<string, unknown>> =>
      raw
        .map((line) => {
          try {
            return JSON.parse(line) as Record<string, unknown>;
          } catch {
            return {};
          }
        })
        .filter((entry) => entry["msg"] === msg);
    return { h, lines };
  }

  it("a signature rejection answers a bare 401 but WARNS with the verifier's reason", async () => {
    const { h, lines } = await loggedHarness();
    const response = await h.app.inject({
      method: "POST",
      url: "/webhooks/jira",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify(issueEvent({ ticket: "UGURPAY-1" })),
    });

    // The response stays deliberately bare — an attacker learns nothing new.
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "webhook_unauthenticated" });

    // The operator's side now says WHY. Before this line a wrong webhook
    // secret looked exactly like "Jira never delivers": zero log output while
    // every delivery bounced.
    const warns = lines("webhook signature rejected");
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({ webhook: "jira" });
    expect(String(warns[0]?.["reason"] ?? "")).not.toBe("");
    // The verifier's reason names the failure, never the shared secret.
    expect(JSON.stringify(warns)).not.toContain(WEBHOOK_SECRET);
  });

  it("an unbound-project drop still answers 202 (M102) but WARNS with ticket and reason", async () => {
    const { h, lines } = await loggedHarness({ bindings: [] });
    const delivery = signed(issueEvent({ ticket: "UGURWEB-9" }));
    const response = await h.app.inject({
      method: "POST",
      url: "/webhooks/jira",
      headers: delivery.headers,
      payload: delivery.payload,
    });

    // Jira's side is unchanged: a 202 that leaks nothing about being watched.
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ accepted: false, reason: "unbound" });

    // The in-memory counter dies with the process; the log line survives it.
    const warns = lines("webhook intake dropped");
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({ ticket: "UGURWEB-9", reason: "unbound" });
  });

  /**
   * The distinction the operator actually needs.
   *
   * Only REFUSALS were logged, so a working webhook and a webhook that never
   * arrived produced identical evidence: nothing. Those two send an operator to
   * two different places — a firewall rule versus a gate that was already
   * closed — and they had no way to tell which they were in.
   */
  it("a VERIFIED delivery is logged, so 'never arrived' and 'arrived and handled' differ", async () => {
    const { h, lines } = await loggedHarness();
    const delivery = signed(issueEvent({ ticket: "UGURPAY-42" }));
    const response = await h.app.inject({
      method: "POST",
      url: "/webhooks/jira",
      headers: delivery.headers,
      payload: delivery.payload,
    });

    expect(response.statusCode).toBe(202);
    const verified = lines("webhook delivery verified");
    expect(verified).toHaveLength(1);
    expect(verified[0]).toMatchObject({
      webhook: "jira",
      event: "jira:issue_created",
      ticket: "UGURPAY-42",
    });

    // And the outcome, so a taken intake is as visible as a dropped one.
    expect(lines("webhook intake handled")[0]).toMatchObject({
      ticket: "UGURPAY-42",
      accepted: true,
    });
  });

  /**
   * The verified line is written AFTER verification, never before.
   *
   * An unverified delivery is an unauthenticated stranger: letting it write a
   * `webhookEvent` name of its choosing into the operator's log would make the
   * log itself an injection surface.
   */
  it("does not log a delivery that failed verification as verified", async () => {
    const { h, lines } = await loggedHarness();
    await h.app.inject({
      method: "POST",
      url: "/webhooks/jira",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify(issueEvent({ ticket: "UGURPAY-1" })),
    });

    expect(lines("webhook delivery verified")).toHaveLength(0);
    expect(lines("webhook signature rejected")).toHaveLength(1);
  });

  /**
   * The SECURITY refusal that used to be perfectly silent.
   *
   * An edited comment carries no command (K-2/M32/M51): in Jira DC "Edit All
   * Comments" is a routine project-lead permission, so honouring one would let
   * its holder approve a gate AS SOMEONE ELSE. The parser answers "no command"
   * — which meant the approver saw their `/approve` ignored with nothing
   * anywhere naming the rule that ignored it.
   */
  it("WARNS by name when an edited comment is refused (SoD protection)", async () => {
    const { h, lines } = await loggedHarness();
    const delivery = signed(
      commentEvent({
        ticket: "UGURPAY-42",
        author: "mert.demir",
        body: "/approve",
        created: "2026-08-09T09:05:00.000+0300",
        updated: "2026-08-09T09:07:00.000+0300",
      }),
    );
    const response = await h.app.inject({
      method: "POST",
      url: "/webhooks/jira",
      headers: delivery.headers,
      payload: delivery.payload,
    });

    expect(response.statusCode).toBe(202);
    const warns = lines(
      "webhook comment refused: an edited comment carries no command (SoD protection)",
    );
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({
      webhook: "jira",
      ticket: "UGURPAY-42",
      reason: "edited_comment",
    });
    // And no command was honoured.
    expect(lines("webhook command handled")).toHaveLength(0);
  });

  /**
   * A command that WAS honoured — including the legitimate non-acceptance.
   *
   * `no_open_gate` is not an operator error; it is the gate already being
   * closed, or the poller having answered the same comment a moment earlier.
   * Until it was logged it looked exactly like a delivery that never arrived.
   */
  it("logs a handled command with its verdict, and the reason when refused", async () => {
    const { h, lines } = await loggedHarness();
    const delivery = signed(
      commentEvent({ ticket: "UGURPAY-42", author: "mert.demir", body: "/approve" }),
    );
    await h.app.inject({
      method: "POST",
      url: "/webhooks/jira",
      headers: delivery.headers,
      payload: delivery.payload,
    });

    const handled = lines("webhook command handled");
    expect(handled).toHaveLength(1);
    expect(handled[0]).toMatchObject({
      webhook: "jira",
      ticket: "UGURPAY-42",
      command: "approve",
      author: "mert.demir",
    });
    // The verdict is there whichever way it went — that IS the diagnostic.
    expect(handled[0]).toHaveProperty("accepted");
  });

  /**
   * An author that is an e-mail address is masked.
   *
   * A Data Center identity falls back to `emailAddress` when the user carries
   * neither `name` nor `key` (`adapter-jira/src/mapping.ts` → `userIdOf`), and
   * an e-mail address in a bank's log aggregator is personal data the platform
   * masks everywhere else (`packages/pii`).
   */
  it("masks an author that is an e-mail address", async () => {
    const { h, lines } = await loggedHarness();
    const delivery = signed(
      commentEvent({ ticket: "UGURPAY-42", author: "mert.demir@banka.com.tr", body: "/approve" }),
    );
    await h.app.inject({
      method: "POST",
      url: "/webhooks/jira",
      headers: delivery.headers,
      payload: delivery.payload,
    });

    const handled = lines("webhook command handled");
    expect(handled).toHaveLength(1);
    expect(handled[0]?.["author"]).toBe("m*********@banka.com.tr");
    expect(JSON.stringify(handled)).not.toContain("mert.demir@banka.com.tr");
  });

  /**
   * The property that makes every line above safe to ask an operator for.
   *
   * These lines are what a bank pastes into a ticket when listening does not
   * work. Not one of them may carry the webhook secret, and none may carry the
   * comment BODY — a Jira comment in a bank routinely names a person, an
   * account or an amount.
   */
  it("leaks neither the webhook secret nor the comment body into ANY line", async () => {
    const { h, lines: _lines } = await loggedHarness();
    const captured: string[] = [];
    // Re-drive with the raw buffer so every line is inspected, not just the
    // ones a message filter selected.
    const raw: string[] = [];
    const logged = await harness({
      fastify: {
        logger: { level: "warn", stream: { write: (line: string) => void raw.push(line) } },
      },
    });
    const secretBody = "/reject IBAN TR33 0006 1005 1978 6457 8413 26 yanlış";
    const delivery = signed(
      commentEvent({ ticket: "UGURPAY-42", author: "mert.demir", body: secretBody }),
    );
    await logged.app.inject({
      method: "POST",
      url: "/webhooks/jira",
      headers: delivery.headers,
      payload: delivery.payload,
    });
    captured.push(...raw);

    const all = captured.join("\n");
    expect(all).not.toContain(WEBHOOK_SECRET);
    expect(all).not.toContain("TR33 0006 1005 1978 6457 8413 26");
    expect(all).not.toContain("x-hub-signature");
    // The ticket key and the command name are business data and DO appear —
    // otherwise the line would be useless to the operator it is written for.
    expect(all).toContain("UGURPAY-42");
    void h;
  });
});

/**
 * The clarify RE-ENTRY gap (step 2b), pinned.
 *
 * `askClarification` (packages/workflows/src/impl/intake.ts) posts the question
 * as a Jira comment, labels the ticket `maestro-bekliyor` and the workflow then
 * waits — unbounded — on `clarificationAnswered`. That signal has exactly two
 * senders in the whole tree: Studio's `POST /runs/:ticket/signals/…` and the
 * test scenario's own fake activity. NOTHING on the Jira side sends it.
 *
 * The two tests below are the two ways a reporter would actually answer, and
 * both are dead ends today. They are written as characterization tests — they
 * assert what the platform DOES, not what it should — so the day the gap is
 * closed they fail loudly and name their own replacement.
 */
/**
 * Jira'dan netleştirmeye yeniden giriş.
 *
 * Kapatılan boşluk: koşu 2b'de `condition(() => inbox.clarified)` ile süresiz
 * bekliyordu ve o koşulu Jira tarafından açan HİÇBİR ŞEY yoktu — kullanıcı
 * ticket'ı düzeltip geri atıyor, olay `runIntake`'e düşüyor, mevcut yürütmeye
 * sinyalsiz katılıyor ve koşu sonsuza dek park kalıyordu.
 *
 * Tetik ATAMA: ticket bot'a geri döndüğünde uyanır. Yankı korumasının üç
 * katmanı (kimlik / yön / zaman) aşağıda ayrı ayrı sınanıyor — hiçbiri tek
 * başına yeterli değil, üçü birden geçmeden sinyal gitmez.
 */
describe("clarify re-entry from Jira (step 2b)", () => {
  const BOT = "maestro-bot";
  /** Soru sorulduğu an. TestClock 09:00'da duruyor, yani teslimat bundan sonra. */
  const ASKED_AT = "2026-08-09T08:30:00.000Z";

  const botHarness = () =>
    harness({
      listeningRules: [CATCH_ALL],
      deps: { config: { actorDomain: "ugurbank.local", engineBotAccountId: BOT } },
    });

  const deliver = async (h: Awaited<ReturnType<typeof harness>>, payload: unknown) => {
    const delivery = signed(payload);
    return h.app.inject({
      method: "POST",
      url: "/webhooks/jira",
      headers: delivery.headers,
      payload: delivery.payload,
    });
  };

  const clarifySignals = (h: Awaited<ReturnType<typeof harness>>) =>
    h.runs.signals.filter((s) => s.name === "clarificationAnswered");

  it("wakes the run when the reporter fixes the ticket and reassigns it to the bot", async () => {
    const h = await botHarness();
    h.runs.openGate("UGURPAY-3", "2b", { awaitingClarificationSince: ASKED_AT });

    const response = await deliver(
      h,
      issueEvent({
        ticket: "UGURPAY-3",
        event: "jira:issue_updated",
        labels: ["maestro"],
        // Düzeltildi ve Maestro'ya geri atandı — birincil tetik bu.
        assignee: BOT,
        actor: "mert.demir",
      }),
    );

    expect(response.statusCode).toBe(202);
    const signals = clarifySignals(h);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      workflowId: "maestro-UGURPAY-3",
      arg: { ticketKey: "UGURPAY-3", answeredBy: "mert.demir" },
    });

    // Cevap denetim zincirine de düşüyor, kaynağıyla birlikte: Studio'dan
    // gelen cevapla Jira'dan gelen cevap sonradan ayırt edilebilmeli.
    const events = await h.auditStore.read();
    const answered = events.filter((event) => event.action === "CLARIFICATION_ANSWERED");
    expect(answered).toHaveLength(1);
    expect(answered[0]?.meta).toMatchObject({ source: "jira_reassign", answeredBy: "mert.demir" });
  });

  it("still runs intake on the same delivery — the re-entry does not replace it", async () => {
    const h = await botHarness();
    h.runs.openGate("UGURPAY-3", "2b", { awaitingClarificationSince: ASKED_AT });

    const response = await deliver(
      h,
      issueEvent({
        ticket: "UGURPAY-3",
        event: "jira:issue_updated",
        labels: ["maestro"],
        assignee: BOT,
        actor: "mert.demir",
      }),
    );

    // Sinyal gitti VE intake yolu işledi: aynı teslimat aynı zamanda etiket
    // ya da statü değişikliği taşıyor olabilir, ve `runIntake` idempotent.
    expect(clarifySignals(h)).toHaveLength(1);
    expect(response.json()).toMatchObject({ accepted: true, started: false });
  });

  // ── yankı önleme: katman 1 · kimlik ────────────────────────────────────────

  it("ignores the echo of Maestro's own change (actor is the bot)", async () => {
    const h = await botHarness();
    h.runs.openGate("UGURPAY-3", "2b", { awaitingClarificationSince: ASKED_AT });

    // Tam olarak tehlikeli senaryo: ticket bot'ta, damga geçilmiş, ama olayı
    // iten bot'un kendisi. Maestro kendi sorusunu kendisi cevaplamamalı.
    await deliver(
      h,
      issueEvent({
        ticket: "UGURPAY-3",
        event: "jira:issue_updated",
        labels: ["maestro"],
        assignee: BOT,
        actor: BOT,
      }),
    );

    expect(clarifySignals(h)).toHaveLength(0);
  });

  it("ignores a delivery that names nobody — an unknown actor is not proof of a human", async () => {
    const h = await botHarness();
    h.runs.openGate("UGURPAY-3", "2b", { awaitingClarificationSince: ASKED_AT });

    await deliver(
      h,
      issueEvent({
        ticket: "UGURPAY-3",
        event: "jira:issue_updated",
        labels: ["maestro"],
        assignee: BOT,
        // `user` yok — Jira kimin ittiğini söylemedi.
      }),
    );

    expect(clarifySignals(h)).toHaveLength(0);
  });

  // ── yankı önleme: katman 2 · yön ───────────────────────────────────────────

  it("does not wake the run while the ticket still sits with the reporter", async () => {
    const h = await botHarness();
    h.runs.openGate("UGURPAY-3", "2b", { awaitingClarificationSince: ASKED_AT });

    // `reassignOnNeedInfo` ticket'ı reporter'a attı; reporter yazmaya devam
    // ediyor ama henüz geri vermedi. Bu "cevabım hazır" değil.
    await deliver(
      h,
      issueEvent({
        ticket: "UGURPAY-3",
        event: "jira:issue_updated",
        labels: ["maestro"],
        assignee: "mert.demir",
        actor: "mert.demir",
      }),
    );

    expect(clarifySignals(h)).toHaveLength(0);
  });

  // ── yankı önleme: katman 3 · zaman ─────────────────────────────────────────

  it("ignores an event received before the question was asked", async () => {
    const h = await botHarness();
    // Soru saat 10:00'da soruldu; TestClock 09:00'da — teslimat sorudan ÖNCE.
    // Bu, `moveStatus("need_info")` ve yeniden atamanın yankısının düştüğü
    // pencere: koruma olmasa koşu vaktinden önce uyanırdı.
    h.runs.openGate("UGURPAY-3", "2b", {
      awaitingClarificationSince: "2026-08-09T10:00:00.000Z",
    });

    await deliver(
      h,
      issueEvent({
        ticket: "UGURPAY-3",
        event: "jira:issue_updated",
        labels: ["maestro"],
        assignee: BOT,
        actor: "mert.demir",
      }),
    );

    expect(clarifySignals(h)).toHaveLength(0);
  });

  it("ignores a 2b run that carries no question timestamp at all", async () => {
    const h = await botHarness();
    // Eski bir sürüm ya da soru henüz sorulmadı: damga yoksa yankıyı cevaptan
    // ayırmanın yolu yok, ve o durumda tetiklememek doğru cevap.
    h.runs.openGate("UGURPAY-3", "2b");

    await deliver(
      h,
      issueEvent({
        ticket: "UGURPAY-3",
        event: "jira:issue_updated",
        labels: ["maestro"],
        assignee: BOT,
        actor: "mert.demir",
      }),
    );

    expect(clarifySignals(h)).toHaveLength(0);
  });

  // ── kapsam dışı durumlar ───────────────────────────────────────────────────

  it("does not wake a run that is not waiting for clarification", async () => {
    const h = await botHarness();
    // Koşu 4. kapıda — bir onay bekliyor, netleştirme değil.
    h.runs.openGate("UGURPAY-3", "4", { awaitingClarificationSince: ASKED_AT });

    await deliver(
      h,
      issueEvent({
        ticket: "UGURPAY-3",
        event: "jira:issue_updated",
        labels: ["maestro"],
        assignee: BOT,
        actor: "mert.demir",
      }),
    );

    expect(clarifySignals(h)).toHaveLength(0);
  });

  it("does nothing when the deployment configured no bot account", async () => {
    // `MAESTRO_BOT_ACCOUNT_ID` boş: kimlik ve yön katmanları ölçülemez, ve
    // ölçülemeyen bir korumayla ilerlemek korumasız ilerlemektir.
    const h = await webhookHarness();
    h.runs.openGate("UGURPAY-3", "2b", { awaitingClarificationSince: ASKED_AT });

    await deliver(
      h,
      issueEvent({
        ticket: "UGURPAY-3",
        event: "jira:issue_updated",
        labels: ["maestro"],
        assignee: BOT,
        actor: "mert.demir",
      }),
    );

    expect(clarifySignals(h)).toHaveLength(0);
  });

  it("a reporter's plain answer comment still sends no signal — the trigger is assignment", async () => {
    const h = await botHarness();
    h.runs.openGate("UGURPAY-3", "2b", { awaitingClarificationSince: ASKED_AT });

    // Bilerek kapsam dışı: bir yorum ticket'ı bot'a geri vermiyor, ve yorum
    // yolu komut grameriyle paylaşılıyor. Cevabın yolu ticket'ı düzeltip
    // Maestro'ya geri atmak.
    const response = await deliver(
      h,
      commentEvent({
        ticket: "UGURPAY-3",
        author: "mert.demir",
        body: "Ortam prod, kabul kriteri: 3 sn altı yanıt süresi.",
      }),
    );

    expect(response.json()).toEqual({ accepted: false, reason: "not_intake" });
    expect(clarifySignals(h)).toHaveLength(0);
  });
});
