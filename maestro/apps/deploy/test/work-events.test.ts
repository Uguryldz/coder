import { describe, expect, it } from "vitest";
import { jiraWorkEventReader } from "../src/work-events.js";

/**
 * The `WorkEventReader` the composition root injects.
 *
 * It is the ONLY place the platform learns a ticket's status: the frozen
 * `TicketSnapshot` carries none, so a listening rule keyed on status can only
 * be answered from the delivery. Getting the extraction wrong would silently
 * send tickets down the wrong flow — a rule that never matches falls back to
 * the deployment default rather than erroring — so it is pinned here.
 */

function issue(fields: Record<string, unknown>): unknown {
  return {
    webhookEvent: "jira:issue_created",
    timestamp: Date.parse("2026-08-09T06:00:00.000Z"),
    issue: { key: "UGURPAY-1", fields },
  };
}

describe("jiraWorkEventReader", () => {
  it("reads status, issue type and assignee out of a Jira delivery", () => {
    const event = jiraWorkEventReader().read(
      issue({
        labels: ["ai-ready"],
        status: { name: "Yapılacak" },
        issuetype: { name: "Hata" },
        assignee: { accountId: "712020:bot" },
      }),
    );

    expect(event).toMatchObject({
      kind: "issue",
      ticketKey: "UGURPAY-1",
      labels: ["ai-ready"],
      status: "Yapılacak",
      issueType: "Hata",
      assignee: "712020:bot",
    });
  });

  it("prefers accountId over the DC name fields (Jira Cloud has only accountId)", () => {
    const event = jiraWorkEventReader().read(
      issue({ assignee: { accountId: "712020:bot", name: "legacy", emailAddress: "bot@corp" } }),
    );
    expect(event.assignee).toBe("712020:bot");
  });

  it("falls back to the DC name when there is no accountId", () => {
    const event = jiraWorkEventReader().read(issue({ assignee: { name: "uyildiz" } }));
    expect(event.assignee).toBe("uyildiz");
  });

  it("leaves fields ABSENT when the payload omits them", () => {
    // Absent must not become "" — an empty string could match a rule whose
    // matchValue is empty, classifying every ticket that simply lacked a status.
    const event = jiraWorkEventReader().read(issue({ labels: [] }));
    expect(event.status).toBeUndefined();
    expect(event.issueType).toBeUndefined();
    expect(event.assignee).toBeUndefined();
    // Kimlikler de aynı kurala tabi: yokluk uydurulmaz.
    expect(event.statusId).toBeUndefined();
    expect(event.issueTypeId).toBeUndefined();
  });

  /**
   * TAKIM YÖNETİMLİ (next-gen) PROJE — teslimatın taşıdığı KİMLİKLER.
   *
   * ── CANLI ÖLÇÜM ───────────────────────────────────────────────────────────
   * O tür projede JQL adları çözmüyor (`issuetype = "Görev"` → 0 ticket,
   * `issuetype = 10008` → 14) ve panel kurala İD kaydediyor. `matches()` de
   * sayısal bir `matchValue`'yu ticket'ın İD'siyle karşılaştırıyor. Teslimat
   * `fields.status.id` ile `fields.issuetype.id`'yi zaten taşıyor; okumamak,
   * o projedeki her kuralın bir tek ticket'ı bile eşleştirememesi demekti.
   */
  it("takım yönetimli projede kimlikleri de okur — adların YANINDA", () => {
    const event = jiraWorkEventReader().read(
      issue({
        labels: [],
        status: { id: "10004", name: "Yapılacaklar" },
        issuetype: { id: "10008", name: "Görev" },
      }),
    );

    expect(event.statusId).toBe("10004");
    expect(event.issueTypeId).toBe("10008");
    // Kimlik adın YERİNE geçmiyor: şirket yönetimli projede eşleşme hâlâ ada
    // düşüyor ve o yol bozulmamalı.
    expect(event.status).toBe("Yapılacaklar");
    expect(event.issueType).toBe("Görev");
  });

  /**
   * Jira kimliği SAYI olarak da gönderebiliyor, kuralın `matchValue`'su ise
   * her zaman metin. Çevirmeyen bir okuyucuda eşleşme `10008 === "10008"`
   * üzerinden sessizce düşerdi.
   */
  it("sayı olarak gelen kimliği metne çevirir", () => {
    const event = jiraWorkEventReader().read(
      issue({ labels: [], issuetype: { id: 10008, name: "Görev" } }),
    );
    expect(event.issueTypeId).toBe("10008");
  });

  /** Adı olan ama kimliği olmayan alan: ad okunur, kimlik UYDURULMAZ. */
  it("adı olup kimliği olmayan alanda kimliği yazmaz", () => {
    const event = jiraWorkEventReader().read(
      issue({ labels: [], issuetype: { name: "Görev" } }),
    );
    expect(event.issueType).toBe("Görev");
    expect(event.issueTypeId).toBeUndefined();
  });

  it("treats an unassigned ticket and a whitespace-only name as unassigned", () => {
    expect(jiraWorkEventReader().read(issue({ assignee: null })).assignee).toBeUndefined();
    expect(jiraWorkEventReader().read(issue({ assignee: { accountId: "   " } })).assignee).toBeUndefined();
  });

  it("ignores a status object that carries no usable name", () => {
    expect(jiraWorkEventReader().read(issue({ status: { name: "  " } })).status).toBeUndefined();
    expect(jiraWorkEventReader().read(issue({ status: "Yapılacak" })).status).toBeUndefined();
  });

  it("trims the names it reads", () => {
    const event = jiraWorkEventReader().read(issue({ status: { name: " Yapılacak " } }));
    expect(event.status).toBe("Yapılacak");
  });

  it("still reads labels, the behaviour it had before flow selection", () => {
    expect(jiraWorkEventReader().read(issue({ labels: ["ai-ready", "x"] })).labels).toEqual(["ai-ready", "x"]);
    expect(jiraWorkEventReader().read(issue({})).labels).toBeUndefined();
  });
});
