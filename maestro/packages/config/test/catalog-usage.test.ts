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
 * `apps/` is scanned too. The guard used to cover `packages/` alone, so an app
 * emitting an unknown key — the runner agent emits `runner_agent.*` — would
 * have thrown `MissingMessageError` in front of an operator with the suite
 * still green.
 */
const APPS_DIR = join(import.meta.dirname, "..", "..", "..", "apps");
/**
 * Every message-key namespace in the monorepo. A package whose namespace is
 * absent here is NOT protected: `publish.*` was missing while the package
 * emitted 39 keys the catalog did not have, so the guard passed and the first
 * published document would have thrown `MissingMessageError` at a human gate.
 * Adding a namespace to a package means adding it here too.
 */
/**
 * Which string literals count as message keys.
 *
 * The prefix list is an allow-list rather than a shape match, because a bare
 * `foo.bar` pattern would sweep up module paths, MIME types and Prisma field
 * selectors. That makes the list load-bearing: a family missing from it is a
 * family the scan cannot see.
 *
 * `intake`, `jira`, `pr` and `agent` were missing, and all nine keys
 * `packages/workflows` emits went uncatalogued because of it — found live,
 * three activity retries deep, as `missing message "intake.manual_completion"
 * for locale "tr"` on a run that had already reached the model. A key that is
 * only exercised on the workflow path is exactly the key a unit test does not
 * reach, which is what this scan exists to cover.
 *
 * `pr.` is enumerated rather than opened up: `pr.number` is a field name in an
 * Azure DevOps webhook payload (`adapter-ado/src/ci.ts`), not a message key,
 * and a prefix match would report it as permanently missing.
 */
/**
 * The namespaces this scan reads, and why the list is explicit.
 *
 * Deriving it from the catalogue was tried and is WRONG: message keys share
 * their shape with file names (`journal.json`, `template.docx`), payload fields
 * (`pr.number`, `state.get`) and parameter names, so every catalogue namespace
 * opened up reports a handful of permanently-missing keys that are not keys at
 * all. The list stays hand-written, and each entry earns its place.
 *
 * `routing` is here because leaving it out is how a live screen broke:
 * `stores/routing.ts` returns its note as `{ key: "routing.note.…" }`, the
 * family went unscanned, a rename never reached the catalogue, every test
 * passed, and the Projects screen died with `MissingMessageError` in front of
 * the operator. **Adding a namespace here is part of adding a server-side
 * message family** — the check below asserts the ones that exist today.
 *
 * `pr.` is enumerated rather than opened up: `pr.number` is a field name in an
 * Azure DevOps webhook payload (`adapter-ado/src/ci.ts`), not a message key,
 * and a prefix match would report it as permanently missing.
 */
const SCANNED_NAMESPACES = [
  "steps",
  "notify",
  "gate",
  "command",
  "match",
  "params",
  "run",
  "evidence",
  "llm",
  "publish",
  "runner_agent",
  "intake",
  "jira",
  "agent",
  "routing",
] as const;
function keyLiteralFor(namespaces: readonly string[]): RegExp {
  const alternation = [...namespaces].sort().join("|");
  return new RegExp(`"((?:${alternation})\\.[a-z0-9_.]+|pr\\.(?:title|description))"`, "g");
}

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    // `test` alongside the build dirs: fixtures are not shipped emitters —
    // helpers build `ParamDefinition` objects with invented keys (`gate.set`,
    // `gate.reminder_days`) that no catalogue can or should carry. Excluding
    // only `*.test.ts` let `test/helpers.ts` through.
    if (entry === "node_modules" || entry === "dist" || entry === ".turbo" || entry === "test") {
      continue;
    }
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, acc);
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) acc.push(full);
  }
  return acc;
}

/**
 * Every M71 parameter key, read from the file that defines them.
 *
 * Read rather than imported: `@maestro/config` is a leaf that `@maestro/db`
 * depends on, so importing the registry here would invert the dependency. The
 * `key:` literals in that one file are the registry, and taking them from the
 * source keeps this list from drifting out of date the way a hand-copied one
 * would.
 */
function parameterKeys(): Set<string> {
  const source = readFileSync(
    join(PACKAGES_DIR, "db", "src", "params-defaults.ts"),
    "utf8",
  );
  const keys = new Set<string>();
  for (const match of source.matchAll(/\bkey:\s*"([a-z0-9_.]+)"/g)) keys.add(match[1]!);
  return keys;
}

/**
 * Packages that ship their OWN message catalogue.
 *
 * `@maestro/agent-roles` renders prompts from `prompts.tr.json`, a separate
 * file with its own keys (`intake.sistem`, `ortak.uydurmaYasak`). Those are not
 * missing from this catalogue — they belong to a different one, and its own
 * tests cover it. Scanning them here would report a permanent, unfixable
 * failure, which is how a guard gets disabled.
 */
const OWN_CATALOGUE = [join(PACKAGES_DIR, "agent-roles", "src")];

describe("message catalog usage (M104)", () => {
  const PARAM_KEYS = parameterKeys();
  /**
   * Every dotted PREFIX the catalog ships — `routing.note.`, `listening.`, … —
   * so a key can be recognised as a message by the company it keeps. Derived,
   * never listed: a family the catalog gains is covered the day it gains it.
   */
  const CATALOG_FAMILIES = new Set(
    catalogKeys(Locale.enum.tr).map((key) => key.slice(0, key.lastIndexOf(".") + 1)),
  );
  const KEY_LITERAL = keyLiteralFor(SCANNED_NAMESPACES);
  const used = new Map<string, string>(); // key -> first file that emits it
  for (const file of [...sourceFiles(PACKAGES_DIR), ...sourceFiles(APPS_DIR)]) {
    if (file.includes(join("config", "src"))) continue; // the catalog itself
    if (OWN_CATALOGUE.some((dir) => file.startsWith(dir))) continue;
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(KEY_LITERAL)) {
      const key = match[1]!;
      /**
       * A PARAMETER key (M71) is not a message key, and the two are shaped
       * identically — `notify.routing` could be either. The catalog cannot
       * contain them, so a scan that treated them as message keys would report
       * a permanent, unfixable failure.
       *
       * They are recognised by NAME rather than by syntax. The check used to
       * be positional (`key:\s*$`), which only covered
       * `{ key: "notify.routing" }` and missed every other way a parameter key
       * legitimately appears — a lookup argument, or a named constant like
       * `PARAM_KEYS.notifyRouting`. Matching the value against the parameter
       * registry covers all of them and cannot drift: a parameter that stops
       * existing stops being excluded.
       */
      if (PARAM_KEYS.has(key)) continue;
      /**
       * The positional form too, for parameter keys that are NOT in the
       * shipped registry: test helpers build `ParamDefinition` fixtures with
       * invented keys (`gate.reminder_days`), and those are parameter keys by
       * position even though no real parameter has the name.
       */
      const before = text.slice(Math.max(0, match.index - 24), match.index);
      /**
       * …but ONLY when the value does not live in a namespace the catalog owns.
       *
       * This escape used to be unconditional, and it is how a live screen broke:
       * `stores/routing.ts` returns its note as `{ key: "routing.note.…" }` —
       * positionally a parameter key, actually a message key — so the scan
       * skipped the whole `routing.note.*` family. When one of them was renamed
       * and the new name never reached the catalog, every test still passed and
       * the Projects screen died with `MissingMessageError` in front of the
       * operator. A key whose first segment names a catalog namespace is a
       * message key regardless of the syntax that carries it.
       */
      /**
       * …but only when nothing about the VALUE says otherwise.
       *
       * Matching on `CATALOG.has(key)` would be circular: a key the catalog
       * lost would stop being checked at the exact moment it started being
       * broken. The family is the honest signal — `routing.note.active_by_rule`
       * is a message key because `routing.note.dry_run` is one, and that stays
       * true while the key itself is missing. This is the gap that let a live
       * screen die: `stores/routing.ts` returns its note as `{ key: "…" }`, so
       * the whole `routing.note.*` family was skipped, the rename never
       * reached the catalog, every test passed, and the Projects screen threw
       * `MissingMessageError` in front of the operator.
       *
       * A parameter key (`gate.set`, `notify.routing`) has no such family: no
       * catalog entry shares its prefix, so it is still excluded.
       */
      const family = key.slice(0, key.lastIndexOf(".") + 1);
      const hasFamily = family !== "" && CATALOG_FAMILIES.has(family);
      /**
       * A `ParamDefinition` literal carries its OWN message key in
       * `descriptionKey`, so the `key:` beside it is a parameter name however
       * much its prefix looks like a catalog family (`gate.set` sits under the
       * shipped `gate.*` messages). The two are told apart by what follows, not
       * by the name.
       */
      const paramLiteral = /descriptionKey:/.test(text.slice(match.index, match.index + 240));
      if ((!hasFamily || paramLiteral) && /(?:^|[^A-Za-z])key:\s*$/.test(before)) continue;
      if (!key.endsWith(".")) used.set(key, used.get(key) ?? file);
    }
  }

  /**
   * The exclusion list must be real. If `params-defaults.ts` moves or its
   * shape changes, `parameterKeys()` would return an empty set and every
   * parameter key would be reported as a missing message key — a confusing
   * failure. Asserting it found something turns that into a clear one.
   */
  it("reads the parameter registry it excludes", () => {
    expect(PARAM_KEYS.size).toBeGreaterThan(10);
    expect(PARAM_KEYS.has("notify.routing")).toBe(true);
  });

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
