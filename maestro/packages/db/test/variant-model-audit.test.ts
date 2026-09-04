import { describe, expect, it } from "vitest";
import {
  auditVariantModels,
  isCloudModelName,
  MODEL_NOT_SELECTED,
  type AuditVariantVersionRow,
  type VariantModelAuditDb,
} from "../src/index.js";

/**
 * The audit that finds cloud model names left behind in an ALREADY-INSTALLED
 * database.
 *
 * `seedDefaultVariants` never touches an existing variant (M38/M83), so an
 * install seeded by an older release keeps `anthropic/claude-sonnet-4.5`
 * forever — unreachable in an air-gapped bank, and the reason an operator saw
 * cloud models after upgrading. These tests pin the two halves that make the
 * repair safe: what counts as a cloud name, and that nothing is written unless
 * the caller explicitly asks.
 */

interface Update {
  variantId: string;
  version: number;
  model: string;
}

function fakeDb(rows: readonly AuditVariantVersionRow[]): {
  db: VariantModelAuditDb;
  updates: Update[];
} {
  const updates: Update[] = [];
  const db: VariantModelAuditDb = {
    variantVersion: {
      // The real delegate is asked for `orderBy: { version: "desc" }`; the fake
      // honours it so the "newest is active" grouping is genuinely exercised.
      findMany: () =>
        Promise.resolve([...rows].sort((left, right) => right.version - left.version)),
      update: (args) => {
        updates.push({
          variantId: args.where.variantId_version.variantId,
          version: args.where.variantId_version.version,
          model: args.data.model,
        });
        return Promise.resolve({});
      },
    },
  };
  return { db, updates };
}

describe("isCloudModelName", () => {
  it("recognises the provider-prefixed and bare names this repo has seeded", () => {
    expect(isCloudModelName("anthropic/claude-sonnet-4.5")).toBe(true);
    expect(isCloudModelName("claude-opus-5")).toBe(true);
    expect(isCloudModelName("openai/gpt-4o-mini")).toBe(true);
    expect(isCloudModelName("gpt-4o-mini")).toBe(true);
  });

  it("does not mistake the open-weight gpt-oss family for a cloud model", () => {
    // Runs on-prem (vLLM/Ollama); the `gpt-` prefix alone must not condemn it.
    expect(isCloudModelName("gpt-oss-120b")).toBe(false);
    expect(isCloudModelName("gpt-oss-20b")).toBe(false);
    expect(isCloudModelName("openai/gpt-oss-120b")).toBe(false);
    expect(isCloudModelName("GPT-OSS-120B")).toBe(false);
  });

  it("does NOT flag an on-prem model whose name merely contains dots or digits", () => {
    // The false positive that would destroy operator trust: a bank's own vLLM
    // serves names like these, and the audit must leave them alone.
    expect(isCloudModelName("mistral-7b-instruct-v0.2")).toBe(false);
    expect(isCloudModelName("qwen2.5-coder-32b")).toBe(false);
    expect(isCloudModelName("kurum-llm/analiz-v3")).toBe(false);
  });

  it("treats the not-selected marker and blanks as NOT cloud names", () => {
    // Otherwise a repaired install would report findings forever.
    expect(isCloudModelName(MODEL_NOT_SELECTED)).toBe(false);
    expect(isCloudModelName("")).toBe(false);
    expect(isCloudModelName(null)).toBe(false);
    expect(isCloudModelName(undefined)).toBe(false);
  });
});

describe("auditVariantModels", () => {
  it("reports without writing anything by default", async () => {
    const fake = fakeDb([
      { variantId: "analyst-default", version: 1, model: "anthropic/claude-sonnet-4.5" },
      { variantId: "engineer-default", version: 1, model: "kurum-llm/kodlama" },
    ]);

    const result = await auditVariantModels(fake.db);

    expect(result.scanned).toBe(2);
    expect(result.findings).toEqual([
      { variantId: "analyst-default", version: 1, model: "anthropic/claude-sonnet-4.5" },
    ]);
    // The whole point of the default mode: an installer may run it every deploy.
    expect(fake.updates).toEqual([]);
    expect(result.repaired).toEqual([]);
  });

  it("judges only the ACTIVE (newest) version, never the history", async () => {
    // An admin who already moved to an on-prem model on v2 is CLEAN, even
    // though v1 still records the cloud name a past release seeded.
    const fake = fakeDb([
      { variantId: "analyst-default", version: 1, model: "anthropic/claude-sonnet-4.5" },
      { variantId: "analyst-default", version: 2, model: "kurum-llm/analiz" },
    ]);

    const result = await auditVariantModels(fake.db);

    expect(result.scanned).toBe(1);
    expect(result.findings).toEqual([]);
  });

  it("repairs only the active version and leaves older versions untouched (M83)", async () => {
    // A run pinned to v1 must keep reading what v1 said, so the repair may
    // never rewrite history — it appends nothing and edits only the newest row.
    const fake = fakeDb([
      { variantId: "analyst-default", version: 1, model: "claude-opus-5" },
      { variantId: "analyst-default", version: 2, model: "anthropic/claude-sonnet-4.5" },
    ]);

    const result = await auditVariantModels(fake.db, { apply: true });

    expect(fake.updates).toEqual([
      { variantId: "analyst-default", version: 2, model: MODEL_NOT_SELECTED },
    ]);
    expect(result.repaired).toEqual(["analyst-default"]);
  });

  it("is idempotent: a second pass over the repaired state finds nothing", async () => {
    const fake = fakeDb([
      { variantId: "analyst-default", version: 1, model: MODEL_NOT_SELECTED },
    ]);

    const result = await auditVariantModels(fake.db, { apply: true });

    expect(result.findings).toEqual([]);
    expect(fake.updates).toEqual([]);
  });

  it("separates 'no variants at all' from 'nothing wrong'", async () => {
    // `scanned` is what tells the operator which of the two they are looking at.
    const result = await auditVariantModels(fakeDb([]).db);
    expect(result.scanned).toBe(0);
    expect(result.findings).toEqual([]);
  });
});
