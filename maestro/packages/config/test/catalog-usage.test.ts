import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Locale } from "@maestro/contracts";
import { catalogKeys } from "../src/index.js";

/**
 * Guard against the failure class that killed v1: a package emits a message
 * key the catalog does not have, `t()` throws at runtime, and the endpoint
 * 500s in production instead of telling the user what went wrong.
 *
 * Scans every package's source for string literals shaped like message keys
 * and asserts each one exists in every locale.
 */
const PACKAGES_DIR = join(import.meta.dirname, "..", "..");
/**
 * Every message-key namespace in the monorepo. A package whose namespace is
 * absent here is NOT protected: `publish.*` was missing while the package
 * emitted 39 keys the catalog did not have, so the guard passed and the first
 * published document would have thrown `MissingMessageError` at a human gate.
 * Adding a namespace to a package means adding it here too.
 */
const KEY_LITERAL =
  /"((?:steps|notify|gate|command|match|params|run|evidence|llm|publish)\.[a-z0-9_.]+)"/g;

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".turbo") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, acc);
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) acc.push(full);
  }
  return acc;
}

describe("message catalog usage (M104)", () => {
  const used = new Map<string, string>(); // key -> first file that emits it
  for (const file of sourceFiles(PACKAGES_DIR)) {
    if (file.includes(join("config", "src"))) continue; // the catalog itself
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(KEY_LITERAL)) {
      const key = match[1]!;
      // `key: "notify.reminder_channel"` is a PARAMETER key (M71), not a
      // message key — same shape, different namespace.
      const before = text.slice(Math.max(0, match.index - 24), match.index);
      if (/(?:^|[^A-Za-z])key:\s*$/.test(before)) continue;
      if (!key.endsWith(".")) used.set(key, used.get(key) ?? file);
    }
  }

  it("finds message keys to check (the scan itself must not silently pass)", () => {
    expect(used.size).toBeGreaterThan(10);
  });

  for (const locale of Locale.options) {
    it(`every emitted key exists in "${locale}"`, () => {
      const known = new Set(catalogKeys(locale));
      const missing = [...used.entries()]
        .filter(([key]) => !known.has(key))
        .map(([key, file]) => `${key} (emitted by ${file.replace(PACKAGES_DIR, "packages")})`);
      expect(missing).toEqual([]);
    });
  }
});
