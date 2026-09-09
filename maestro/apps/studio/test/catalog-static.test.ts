import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { catalogKeys } from "@maestro/config";
import { SELECTABLE_GATES } from "@maestro/contracts";

/**
 * Every message key the Studio source names LITERALLY — `t("dash.title")`,
 * `t("x", { ... })` — must exist in the catalogue. A missing key is not a
 * fallback: `MissingMessageError` turns the whole screen red at render time,
 * and a screen the tests do not walk ships blind. The config package's own
 * scan (`catalog-usage.test.ts`) covers a hand-kept namespace list for the
 * backend emitters; this one covers the Studio wholesale, so a new screen
 * cannot fall outside the list.
 *
 * Dynamic keys (`t(\`gate.${kind}\`)`) cannot be read statically and are the
 * screen tests' job.
 */

const SRC = join(__dirname, "..", "src");
/** A dotted message key as a string literal. */
const KEY = /"([a-z][a-z0-9_]*(?:\.[a-z0-9_-]+)+)"/g;

/**
 * The literal keys inside every `t(...)` call: the plain `t("a.b")`, and the
 * `t(flag ? "a.b" : "a.c")` form, whose second key the first version of this
 * scan missed — and a screen shipped with a key that existed only in one of
 * the two branches. Only the first argument is read — the options object
 * after the comma is not a key and may nest calls that carry dotted literals
 * of their own.
 */
function literalKeys(text: string): string[] {
  const keys: string[] = [];
  const CALL = /\bt\(/g;
  for (const call of text.matchAll(CALL)) {
    let depth = 1;
    let dynamic = false;
    let i = call.index + call[0].length;
    for (; i < text.length && depth > 0; i += 1) {
      if (text[i] === "(") depth += 1;
      else if (text[i] === ")") depth -= 1;
      // Only the FIRST argument is the key. The options object after the
      // comma may nest other calls with their own dotted literals
      // (`{ role: enumLabel("llm.role", x).text }`), which are label
      // families, not message keys.
      else if (text[i] === "," && depth === 1) break;
      else if (text[i] === "`") {
        // A template key is dynamic — the screen tests' job. The call is
        // skipped WHOLE: cutting the walk short here would hand the rest of
        // the file to the literal scan as if it were this call's arguments.
        dynamic = true;
        break;
      }
    }
    if (dynamic) continue;
    const args = text.slice(call.index + call[0].length, i);
    for (const match of args.matchAll(KEY)) keys.push(match[1]!);
  }
  return keys;
}

function sources(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sources(full, acc);
    else if (/\.tsx?$/.test(entry)) acc.push(full);
  }
  return acc;
}

describe("studio catalog coverage", () => {
  it("has every literal t() key of the Studio source in both locales", () => {
    const tr = new Set(catalogKeys("tr"));
    const en = new Set(catalogKeys("en"));
    const missing: string[] = [];
    for (const file of sources(SRC)) {
      const text = readFileSync(file, "utf8");
      for (const key of literalKeys(text)) {
        if (!tr.has(key) || !en.has(key)) missing.push(`${key}  (${file.slice(SRC.length + 1)})`);
      }
    }
    expect(missing).toEqual([]);
  });

  /**
   * Keys DERIVED from a fixed list with a constant suffix — `t(`${gate.titleKey}.hint`)`
   * over `SELECTABLE_GATES`. The scan above skips them as dynamic, and that gap
   * shipped: every `gates.meaning.*.hint` was missing, so opening the listening
   * rule form (and the setup pane) threw `MissingMessageError` and the screen
   * went red on a live install.
   *
   * The suffix is a literal in the source, so the key set is knowable here:
   * take the list's own `titleKey` values and require base + suffix in both
   * locales. Only this one derivation is covered, deliberately — a general
   * template resolver would be a second, weaker copy of the compiler.
   */
  it("has every suffixed key derived from SELECTABLE_GATES in both locales", () => {
    const tr = new Set(catalogKeys("tr"));
    const en = new Set(catalogKeys("en"));
    const suffixes = new Set<string>();
    for (const file of sources(SRC)) {
      for (const match of readFileSync(file, "utf8").matchAll(/\$\{gate\.titleKey\}(\.[a-z0-9_]+)/g)) {
        suffixes.add(match[1]!);
      }
    }
    const missing: string[] = [];
    for (const gate of SELECTABLE_GATES) {
      for (const key of [gate.titleKey, ...[...suffixes].map((s) => `${gate.titleKey}${s}`)]) {
        if (!tr.has(key) || !en.has(key)) missing.push(key);
      }
    }
    expect(missing).toEqual([]);
  });
});
