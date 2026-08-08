import { describe, expect, it } from "vitest";
import { Locale, STEP_IDS } from "@maestro/contracts";
import { catalogKeys, DEFAULT_LOCALE, loadEnv, MissingMessageError, t } from "../src/index.js";

describe("loadEnv (M6 fail-closed)", () => {
  it("provides dev defaults", () => {
    const env = loadEnv({});
    expect(env.NODE_ENV).toBe("development");
  });
  it("rejects malformed urls", () => {
    expect(() => loadEnv({ JIRA_BASE_URL: "not-a-url" })).toThrow(/JIRA_BASE_URL/);
  });
  it("refuses to start production with missing connections", () => {
    expect(() => loadEnv({ NODE_ENV: "production" })).toThrow(/required in production/);
  });
  it("accepts a fully configured production env", () => {
    const env = loadEnv({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://maestro:x@db:5432/maestro",
      TEMPORAL_ADDRESS: "temporal:7233",
      JIRA_BASE_URL: "https://jira.corp.local",
      ADO_BASE_URL: "https://tfs.corp.local/Collection",
      VAULT_ADDR: "https://vault.corp.local",
      STORAGE_ENDPOINT: "https://s3.corp.local",
    });
    expect(env.NODE_ENV).toBe("production");
  });
});

describe("message catalog (M104)", () => {
  it("all locales share the exact same key set", () => {
    const keySets = Locale.options.map((l) => catalogKeys(l));
    for (const keys of keySets.slice(1)) expect(keys).toEqual(keySets[0]);
  });
  it("no catalog entry is empty", () => {
    for (const locale of Locale.options) {
      for (const key of catalogKeys(locale)) {
        expect(t(locale, key).trim().length, `${locale}:${key}`).toBeGreaterThan(0);
      }
    }
  });
  it("every workflow step has a title in every locale", () => {
    for (const locale of Locale.options) {
      for (const step of STEP_IDS) expect(() => t(locale, `steps.${step}`)).not.toThrow();
    }
  });
  it("interpolates params and keeps unknown placeholders visible", () => {
    const msg = t("tr", "notify.gate_open", { ticket: "UGURPAY-501", gate: "PR onayı", owner: "Ayşe" });
    expect(msg).toContain("UGURPAY-501");
    expect(msg).toContain("PR onayı");
    const partial = t("en", "notify.gate_open", { ticket: "UGURPAY-501" });
    expect(partial).toContain("{gate}");
  });
  it("missing keys fail loudly, no silent fallback", () => {
    expect(() => t(DEFAULT_LOCALE, "no.such.key")).toThrow(MissingMessageError);
  });
});
