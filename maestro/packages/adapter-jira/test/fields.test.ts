import { describe, expect, it } from "vitest";
import { JiraDcConfig, JiraDcWorkPort, fieldText, fieldsFromIssue, normalizeFieldList } from "../src/index.js";
import { stubFetch, type FetchStub } from "./helpers.js";

/**
 * Issue fields as the TEXT a person sees — what the listening rule's repo map
 * compares against ("İş Ailesi" = "Krediler").
 */
describe("fieldText", () => {
  it("flattens Jira's field shapes to the displayed text", () => {
    expect(fieldText("Krediler")).toBe("Krediler");
    expect(fieldText({ value: "Krediler", id: "10001" })).toBe("Krediler");
    expect(fieldText({ name: "Kartlar" })).toBe("Kartlar");
    expect(fieldText({ displayName: "Ayşe Kaya" })).toBe("Ayşe Kaya");
    expect(fieldText([{ value: "A" }, { value: "B" }])).toBe("A, B");
    expect(fieldText(42)).toBe("42");
    expect(fieldText(null)).toBeNull();
    expect(fieldText("   ")).toBeNull();
    expect(fieldText({ id: "10001" })).toBeNull();
  });

  it("reads only the asked-for fields out of an issue body", () => {
    const raw = { key: "OPS-1", fields: { customfield_10234: { value: "Krediler" }, summary: "x", customfield_9: null } };
    expect(fieldsFromIssue(raw, ["customfield_10234", "customfield_9", "missing"])).toEqual({ customfield_10234: "Krediler" });
    expect(fieldsFromIssue(null, ["a"])).toEqual({});
  });
});

describe("normalizeFieldList", () => {
  it("keeps custom fields first, then every mappable system field", () => {
    const fields = normalizeFieldList([
      { id: "summary", name: "Summary", custom: false, schema: { type: "string" } },
      { id: "components", name: "Component/s", custom: false, schema: { type: "array" } },
      { id: "customfield_10234", name: "İş Ailesi", custom: true, schema: { type: "option" } },
      { id: "customfield_10001", name: "Sprint", custom: true },
      { id: "", name: "broken" },
      "junk",
    ]);
    // Turkish collation: "İş Ailesi" sorts before "Sprint".
    expect(fields.map((f) => f.id)).toEqual(["customfield_10234", "customfield_10001", "components"]);
    expect(fields[0]).toEqual({ id: "customfield_10234", name: "İş Ailesi", custom: true, type: "option" });
    expect(normalizeFieldList({ not: "a list" })).toEqual([]);
  });

  /**
   * BEYAZ LİSTE DEĞİL, KARA LİSTE.
   *
   * Eleme bir dönem altı adlık bir beyaz listeydi ve sahada 52 alanlık bir
   * Jira'da yalnız 9 alan seçilebiliyordu. Elenenler arasında eşleme için
   * gerçekten anlamlı olanlar vardı; operatör aradığı alanı bulamayınca
   * sistemi bozuk sandı. Bu test o alanların listede DURDUĞUNU tutuyor —
   * biri tekrar elenirse buradan haber verir.
   */
  it("keeps the system fields a repository can genuinely be routed on", () => {
    const routable = [
      { id: "status", name: "Durum", custom: false, schema: { type: "status" } },
      { id: "assignee", name: "Atanan Kişi", custom: false, schema: { type: "user" } },
      { id: "reporter", name: "Raporlayan", custom: false, schema: { type: "user" } },
      { id: "resolution", name: "Çözüm", custom: false, schema: { type: "resolution" } },
      { id: "environment", name: "Ortam", custom: false, schema: { type: "string" } },
      { id: "parent", name: "Üst Öğe", custom: false, schema: { type: "issuelink" } },
      { id: "security", name: "Güvenlik Düzeyi", custom: false, schema: { type: "securitylevel" } },
      { id: "labels", name: "Etiketler", custom: false, schema: { type: "array" } },
      { id: "priority", name: "Öncelik", custom: false, schema: { type: "priority" } },
    ];
    const ids = normalizeFieldList(routable).map((f) => f.id);
    for (const field of routable) expect(ids).toContain(field.id);
  });

  /**
   * Elenenler "gereksiz" oldukları için değil, EŞLENEMEZ oldukları için
   * elenir: bir sayaç her ticket'ta farklıdır (satır ikinci bir ticket'a hiç
   * uymaz), serbest metnin ise eşlenecek ayrık bir değeri yoktur.
   */
  it("drops counters, timestamps and free text — a map row could never match twice", () => {
    const ids = normalizeFieldList([
      { id: "created", name: "Oluşturulan", custom: false, schema: { type: "datetime" } },
      { id: "updated", name: "Güncellendi", custom: false, schema: { type: "datetime" } },
      { id: "timespent", name: "Harcanan Süre", custom: false, schema: { type: "number" } },
      { id: "workratio", name: "Çalışma Oranı", custom: false, schema: { type: "number" } },
      { id: "votes", name: "Oylar", custom: false, schema: { type: "votes" } },
      { id: "summary", name: "Özet", custom: false, schema: { type: "string" } },
      { id: "description", name: "Açıklama", custom: false, schema: { type: "string" } },
      { id: "comment", name: "Yorum", custom: false, schema: { type: "comments-page" } },
      { id: "attachment", name: "Ek", custom: false, schema: { type: "array" } },
      { id: "project", name: "Proje", custom: false, schema: { type: "project" } },
      { id: "issuekey", name: "Anahtar", custom: false, schema: { type: "string" } },
      { id: "labels", name: "Etiketler", custom: false, schema: { type: "array" } },
    ]).map((f) => f.id);
    expect(ids).toEqual(["labels"]);
  });

  it("drops Jira's own machinery fields (rank, dev panel, issue colour) but KEEPS team", () => {
    const fields = normalizeFieldList([
      { id: "customfield_10019", name: "Rank", custom: true, schema: { type: "any", custom: "com.pyxis.greenhopper.jira:gh-lexo-rank" } },
      { id: "customfield_10000", name: "development", custom: true, schema: { type: "any", custom: "com.atlassian.jira.plugins.jira-development-integration-plugin:devsummarycf" } },
      { id: "customfield_10001", name: "Team", custom: true, schema: { type: "team", custom: "com.atlassian.jira.plugin.system.customfieldtypes:atlassian-team" } },
      { id: "customfield_10017", name: "Konu rengi", custom: true, schema: { type: "string", custom: "com.pyxis.greenhopper.jira:jsw-issue-color" } },
      { id: "customfield_10234", name: "İş Ailesi", custom: true, schema: { type: "option", custom: "com.atlassian.jira.plugin.system.customfieldtypes:select" } },
    ]);
    // "Which team owns this" is a real routing rule, so the team field stays;
    // an instance may have no other custom field worth mapping on.
    expect(fields.map((f) => f.id)).toEqual(["customfield_10234", "customfield_10001"]);
  });
});

describe("JiraDcWorkPort.readFields", () => {
  const config = JiraDcConfig.parse({
    baseUrl: "https://jira.internal.bank",
    tokenRef: "kv/jira/pat",
    webhookSecretRef: "kv/jira/webhook",
  });
  const port = (stub: FetchStub): JiraDcWorkPort =>
    new JiraDcWorkPort({ config, token: () => "pat-123", webhookSecret: () => "s", fetchImpl: stub.fetchImpl, sleep: stub.sleep });

  it("asks Jira for exactly the mapped field and returns its text", async () => {
    const stub = stubFetch([{ body: { key: "OPS-7", fields: { customfield_10234: { value: "Krediler" } } } }]);
    expect(await port(stub).readFields("OPS-7", ["customfield_10234"])).toEqual({ customfield_10234: "Krediler" });
    expect(stub.calls[0]!.url).toContain("/rest/api/2/issue/OPS-7?fields=customfield_10234");
  });

  it("drops ids that are not field ids and makes no call when nothing is left", async () => {
    const stub = stubFetch([]);
    expect(await port(stub).readFields("OPS-7", ["../x", " "])).toEqual({});
    expect(stub.calls).toHaveLength(0);
  });
});
