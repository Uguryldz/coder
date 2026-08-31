import type { TestWorkflowEnvironment } from "@temporalio/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Scenario, createTestEnv, runTicket } from "./harness.js";

/**
 * "EKSİK VAR, BİR DAHA BAK" — kapının ÜÇÜNCÜ cevabı, ve neden bir ret değil.
 *
 * ── Operatörün akışı, kendi ifadesiyle ────────────────────────────────────
 * "analiz başarılı, analiz onaya gönderirsin. insan eksik varsa geri analize
 *  gönderir, BAĞLAM KAYBI YOK."
 *
 * Bu cümledeki iki iddia bu dosyanın tamamı: (1) geri gönderme bir ceza değil,
 * (2) bağlam korunur.
 *
 * ── Neden `reject` ile yazılamazdı ────────────────────────────────────────
 * Ret üç şey yapar ve üçü de burada YANLIŞ olurdu:
 *
 *   · M54 ret sayacını artırır ve ÜÇÜNCÜSÜNDE koşuyu insana devreder. Geri
 *     gönderme rutin bir inceleme turu; üç turda bir koşunun durması, normal
 *     çalışmayı arıza saymak olurdu.
 *   · Denetim zincirine `GATE_REJECT` yazar. Bir denetçinin "kaç kez
 *     reddedildi" sorusuna rutin turları ret sayarak cevap vermek, hem sayıyı
 *     hem anlamı bozar.
 *   · Ticket'ı `onRejected` statüsüne taşır — operatörün açıkça istemediği,
 *     "reddedildi" diyen sert bir hareket.
 *
 * Ortak olan da bilerek ortak: analiz yeniden yazılır ve koşu `continueAsNew`
 * ile DEVAM eder, yani bağlam (kural, akış, ajan varyantı, statü eşlemesi,
 * resume token, ret sayaçları) taşınır.
 */

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await createTestEnv();
});

afterAll(async () => {
  await env?.teardown();
});

describe("analize geri gönderme (kapı 4/5)", () => {
  it("analizi yeniden yazdırır ve kapıyı yeniden açar", async () => {
    const run = await runTicket(
      env,
      new Scenario({
        risk: "dusuk",
        gate: (step, visit) =>
          step === "5" && visit === 1 ? { kind: "return_once", reason: "kabul kriterleri eksik" } : { kind: "approve" },
      }),
    );

    expect(run.error).toBeNull();
    expect(run.status).toBe("done");
    // Kapı 5 İKİ KEZ açıldı: geri gönderme onu kapatıp analizi yeniden
    // yazdırdı, ve yeni analiz aynı kapıya geri geldi.
    expect(run.scenario.opened.filter((step) => step === "5")).toHaveLength(2);
    // İki karar: bir geri gönderme, bir onay.
    const gate5 = run.scenario.decisions.filter((d) => d.step === "5");
    expect(gate5.map((d) => d.decision)).toEqual(["return_analysis", "approve"]);
  });

  /**
   * Bu dosyanın en önemli testi: ÜÇTEN FAZLA geri gönderme, ve koşu hâlâ
   * ayakta. Aynı senaryo `reject_always` ile yazılsaydı üçüncü turda
   * `handover`a düşerdi (M54) — ve operatörün akışında bu, üç kez "bir daha
   * bak" diyen bir inceleyicinin süreci kırması demek olurdu.
   */
  it("ret sayacına GİRMEZ — dört tur geri gönderme koşuyu devretmez", async () => {
    const run = await runTicket(
      env,
      new Scenario({
        risk: "dusuk",
        gate: (step, visit) =>
          step === "5" && visit <= 4 ? { kind: "return_always" } : { kind: "approve" },
      }),
    );

    expect(run.status).toBe("done");
    expect(run.status).not.toBe("handover");
    expect(run.scenario.opened.filter((step) => step === "5")).toHaveLength(5);
    expect(
      run.scenario.decisions.filter((d) => d.step === "5" && d.decision === "return_analysis"),
    ).toHaveLength(4);
  });

  /**
   * BAĞLAM: analiz yeniden YAZILIR, ve koşu aynı koşu olarak sürer. Geri
   * gönderme bir yeniden başlatma değil bir devam — `continueAsNew` girdisi
   * kuralın seçtiği akışı, ajanı ve statü eşlemesini taşır, ve bu testte
   * gözlenebilir hâli akışın sonuna kadar aynı akış olarak gitmesidir.
   */
  it("analizi yeniden yazdırır ve koşuyu aynı akışta sürdürür", async () => {
    const run = await runTicket(
      env,
      new Scenario({
        risk: "dusuk",
        flow: "analiz",
        gate: (step, visit) => (step === "5" && visit === 1 ? { kind: "return_once" } : { kind: "approve" }),
      }),
    );

    expect(run.status).toBe("done");
    // Akış korundu: `analiz` akışı mühendisliğe hiç girmez, ve geri gönderme
    // bunu değiştirmedi — girdi `continueAsNew` üzerinden taşındı.
    expect(run.scenario.engineering).toHaveLength(0);
    expect(run.scenario.delivered).toBe(true);
  });

  /**
   * Maestro ticket'ı `onRejected` statüsüne TAŞIMAZ. Ticket'ı incelemeden
   * çıkaran hareketi zaten operatörün kendisi yaptı; üstüne bir "reddedildi"
   * yazmak, operatörün açıkça istemediği şey.
   */
  it("ticket'ı 'reddedildi' statüsüne taşımaz", async () => {
    const run = await runTicket(
      env,
      new Scenario({
        risk: "dusuk",
        statusMap: { onReview: "İNCELEMEDE", onRejected: "Reddedildi", onDone: "Tamam" },
        gate: (step, visit) => (step === "5" && visit === 1 ? { kind: "return_once" } : { kind: "approve" }),
      }),
    );

    expect(run.status).toBe("done");
    expect(run.scenario.moves.map((m) => m.at)).not.toContain("rejected");
  });

  it("ticket'a 'analize geri gönderildi' satırı düşer — sessiz bir tur değil", async () => {
    const run = await runTicket(
      env,
      new Scenario({
        risk: "dusuk",
        gate: (step, visit) => (step === "5" && visit === 1 ? { kind: "return_once" } : { kind: "approve" }),
      }),
    );

    expect(
      run.scenario.journal.some((line) => line.title.includes("analize geri gönderildi")),
    ).toBe(true);
  });

  /**
   * MÜHENDİSLİK kapılarında (9/11/12) geri gönderme bir cevap DEĞİL: o noktada
   * analiz onaylanmış, kod yazılmış, PR açılmıştır ve analize dönmek yazılmış
   * işi ıskartaya çıkarmak olurdu.
   *
   * Kapı AÇIK kalır — sessizce onay sayılmaz (kodu onaysız geçirirdi) ve ret
   * sayılmaz (kararı verenin demediği bir şeyi ona söyletirdi).
   */
  it("PR kapısında (12) reddedilir, kapı AÇIK kalır ve gerçek bir karar bekler", async () => {
    /**
     * Geri gönderme sinyali kapıyı KAPATMAZ; kapı bekler ve bir sonraki
     * hatırlatma turunda bir insan gerçekten onaylar. Ölçülen şey tam olarak
     * budur: kabul edilmemiş bir karar koşuyu ne ilerletir ne öldürür.
     *
     * `approve_after_hours` ile sürüyoruz çünkü `openGate` bir kez çalışır ve
     * ikinci bir karar ancak hatırlatma merdiveninden gelebilir — bir kapının
     * gerçek hayatta nasıl kapandığının aynısı.
     */
    const run = await runTicket(
      env,
      new Scenario({
        risk: "dusuk",
        gate: (step) => (step === "12" ? { kind: "approve_after_hours", hours: 2 } : { kind: "approve" }),
        // İlk karar hatırlatmadan ÖNCE, kapı açılır açılmaz gelir ve
        // reddedilir; onay iki saat sonra hatırlatma yoluyla gelir.
        earlyDecision: (step, visit) =>
          step === "12" && visit === 1
            ? {
                step: "12",
                decision: "return_analysis",
                actorUserId: "ayse.kaya@bank",
                actorGroup: "tech-leads",
                sodVerified: true,
                signatureSeq: 1,
                source: "jira",
                at: "2026-08-09T10:00:00+03:00",
              }
            : null,
      }),
    );

    expect(run.status).toBe("done");
    // Geri gönderme YUTULMADI: reddedildi, ve reddin sebebi ticket'a yazıldı.
    expect(
      run.scenario.journal.some(
        (line) => line.title === "karar reddedildi" && line.detail.includes("not_returnable"),
      ),
    ).toBe(true);
    // Ve kapı 12'ye ANALİZE DÖNÜŞ olmadı: kapı 5 bir kez açıldı, tek turluk.
    expect(run.scenario.opened.filter((step) => step === "5")).toHaveLength(1);
  });
});
