import { TicketSnapshot } from "@maestro/contracts";
import { describe, expect, it } from "vitest";
import { ISSUE_FIELDS, JiraResponseError, mapIssueToSnapshot, normalizeJiraDateTime, userIdOf } from "../src/index.js";
import { fixture } from "./helpers.js";

describe("issue mapping", () => {
  it("maps a recorded DC issue into a contract-valid TicketSnapshot", () => {
    const snapshot = mapIssueToSnapshot(fixture("issue-get"));

    // The adapter output must survive the frozen contract, not just look right.
    expect(() => TicketSnapshot.parse(snapshot)).not.toThrow();
    expect(snapshot).toMatchObject({
      key: "UGURPAY-501",
      projectKey: "UGURPAY",
      issueType: "Story",
      // Adın yanında Jira'nın kendi kimliği: takım yönetimli bir projede
      // dinleme kuralı bu değeri tutar (`flow-decision.ts`).
      issueTypeId: "10001",
      reporter: "ayse.kaya",
      assignee: "mert.demir",
      components: ["auth-service", "web-frontend"],
      labels: ["maestro", "guvenlik"],
      parentKey: "UGURPAY-490",
    });
    expect(snapshot.createdAt).toBe("2026-07-31T09:14:02.000+03:00");
    expect(snapshot.updatedAt).toBe("2026-08-08T13:12:33.000+03:00");
    expect(snapshot.description).toContain("6 haneli kod");
  });

  it("maps the issue embedded in a webhook envelope too", () => {
    const payload = fixture("webhook-issue-created") as { issue: unknown };
    const snapshot = mapIssueToSnapshot(payload.issue);

    expect(snapshot.assignee).toBeNull();
    expect(snapshot.parentKey).toBeNull();
    expect(snapshot.components).toEqual([]);
    expect(TicketSnapshot.parse(snapshot).labels).toEqual(["maestro"]);
  });

  /**
   * Kimliği olmayan bir belge kimlik UYDURMAZ: alan sözleşmede opsiyonel ve
   * yokluğu "bu belge söylemedi" demek. `""` ya da `null` yazmak, ölçülmemiş
   * bir şeyi ölçülmüş gibi göstermek olurdu — ve `NonEmpty` bir boş dizeyi
   * zaten reddederdi.
   */
  it("omits issueTypeId when the payload carries no issue-type id", () => {
    const raw = structuredClone(fixture("issue-get")) as {
      fields: { issuetype: Record<string, unknown> };
    };
    delete raw.fields.issuetype["id"];
    const snapshot = mapIssueToSnapshot(raw);

    expect(snapshot.issueType).toBe("Story");
    expect(snapshot.issueTypeId).toBeUndefined();
    expect(() => TicketSnapshot.parse(snapshot)).not.toThrow();
  });

  /**
   * STATÜ — yeniden başlatma yolunun kuralı kaybetmemesi için.
   *
   * Anlık görüntü bir dönem statü taşımıyordu ve o karar `restartDeadRun`
   * yolunu sessizce kırıyordu: statü kapısı taşıyan bir kural bilinmeyen
   * statüde KAPANIR (fail-closed), dolayısıyla yeniden başlatmada hiçbir
   * kural eşleşmez, `ruleId` olmaz ve depo eşlemesi hiç sorulmaz.
   *
   * Canlıda ölçüldü (OPS-123): aynı ticket webhook yolundan
   * `tecnoi-global/wendoc`, yeniden başlatma yolundan proje varsayılanı
   * alıyordu — tek fark giriş yoluydu.
   */
  it("carries the status name and id so a status-gated rule can match", () => {
    const raw = structuredClone(fixture("issue-get")) as {
      fields: Record<string, unknown>;
    };
    raw.fields["status"] = { id: "10004", name: "Yapılacaklar" };
    const snapshot = mapIssueToSnapshot(raw);

    expect(snapshot.status).toBe("Yapılacaklar");
    expect(snapshot.statusId).toBe("10004");
    expect(() => TicketSnapshot.parse(snapshot)).not.toThrow();
  });

  it("omits status entirely when the payload carries none", () => {
    // "Jira vermedi" ile "bu yol hiç sormadı" ayrı cevaplardır: yokluk HİÇ
    // yazılmaz, `null` olarak değil — `issueTypeId` ile birebir aynı gerekçe.
    const raw = structuredClone(fixture("issue-get")) as { fields: Record<string, unknown> };
    delete raw.fields["status"];
    const snapshot = mapIssueToSnapshot(raw);

    expect(snapshot.status).toBeUndefined();
    expect(snapshot.statusId).toBeUndefined();
    expect(() => TicketSnapshot.parse(snapshot)).not.toThrow();
  });

  it("reports which field is missing instead of dying inside zod", () => {
    const broken = { key: "UGURPAY-1", fields: { created: "2026-01-01T00:00:00.000+0300", updated: "2026-01-01T00:00:00.000+0300" } };
    const error = (() => {
      try {
        mapIssueToSnapshot(broken);
      } catch (e) {
        return e;
      }
    })();

    expect(error).toBeInstanceOf(JiraResponseError);
    expect((error as JiraResponseError).issues.join(" ")).toMatch(/issueType|summary|reporter/);
  });

  it("rejects payloads that are not issues at all", () => {
    expect(() => mapIssueToSnapshot(null)).toThrow(JiraResponseError);
    expect(() => mapIssueToSnapshot({ key: "UGURPAY-1" })).toThrow(/missing fields object/);
  });

  it("falls back through the DC identity fields", () => {
    expect(userIdOf({ name: "mert.demir", key: "JIRAUSER1" })).toBe("mert.demir");
    expect(userIdOf({ key: "JIRAUSER1" })).toBe("JIRAUSER1");
    expect(userIdOf({ displayName: "Mert Demir" })).toBe("Mert Demir");
    expect(userIdOf(null)).toBeNull();
  });

  it("normalises DC offsets and epoch millis", () => {
    expect(normalizeJiraDateTime("2026-08-08T13:12:33.000+0300", "t")).toBe("2026-08-08T13:12:33.000+03:00");
    expect(normalizeJiraDateTime("2026-08-08T10:12:33.000Z", "t")).toBe("2026-08-08T10:12:33.000Z");
    expect(normalizeJiraDateTime(1786183953000, "t")).toBe("2026-08-08T10:12:33.000Z");
    expect(() => normalizeJiraDateTime("dün", "t")).toThrow(JiraResponseError);
    expect(() => normalizeJiraDateTime(undefined, "t")).toThrow(JiraResponseError);
  });

  it("requests only stock fields — no custom field dependency (M98)", () => {
    expect(ISSUE_FIELDS.split(",")).toContain("components");
    expect(ISSUE_FIELDS).not.toContain("customfield");
  });
});
