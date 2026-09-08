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
  it("keeps custom fields first and only the mappable system fields", () => {
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
