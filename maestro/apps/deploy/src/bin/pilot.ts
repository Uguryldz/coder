import { bootPilot, type VariantModelReader } from "@maestro/pilot";
import { createDb } from "@maestro/db";
import { PrismaVariantModelReader } from "../stores/variant-model-reader.js";
import { fail, install, isEntrypoint } from "./lifecycle.js";

/**
 * The LIVE pilot launcher — the one process that boots the pilot DB-FIRST.
 *
 * `apps/pilot/src/main.ts` is the standalone, DB-free entry: it boots the pilot
 * with no `variantReader`, so it falls back to the bootstrap `PILOT_MODEL` (env)
 * with a loud warning. That is the right behaviour for an offline/dev pilot with
 * no database, but it is NOT what an admin who set a model in Studio expects the
 * live pilot to run.
 *
 * This launcher closes that gap. It lives in the composition root (`apps/deploy`),
 * the one app that may talk to Postgres, and hands the pilot a
 * `PrismaVariantModelReader` over the real `VariantVersion` table. With the
 * reader wired, `bootPilot` resolves each role's model from its variant's active
 * version (the DB — what Studio wrote) and the env-fallback warning is not
 * emitted. The pilot package stays DB-free: it only ever sees the
 * `VariantModelReader` port, never `@maestro/db`.
 *
 * `DATABASE_URL` is required here on purpose. This binary's whole reason to
 * exist is the DB-first path; a deployment that has no database should run the
 * standalone `main.ts` (env fallback) instead, so booting this one without a URL
 * is a configuration error we fail closed on (M6) rather than silently degrade.
 */

/**
 * Build the pilot's variant-model reader from the environment.
 *
 * Extracted from `main` so the DB-first-vs-fail decision is unit-testable
 * without a live Postgres: pass an env map and assert on the outcome. Returns
 * the reader when a `DATABASE_URL` is present; throws (fail-closed) when it is
 * not, because this launcher exists specifically to run DB-first — an absent
 * URL means the operator picked the wrong entrypoint.
 *
 * `createDb` is injectable so a test proves the wiring (which delegate the
 * reader is built over) without opening a connection; the real caller passes the
 * real `createDb`, whose construction is lazy (no query until first use).
 */
export function variantReaderFromEnv(
  env: Record<string, string | undefined>,
  makeDb: typeof createDb = createDb,
): VariantModelReader {
  const url = env["DATABASE_URL"]?.trim();
  if (url === undefined || url === "") {
    throw new Error(
      "DATABASE_URL is required for the DB-first pilot launcher — " +
        "run apps/pilot (main.ts) for the standalone env-fallback pilot instead.",
    );
  }
  const db = makeDb(url);
  return new PrismaVariantModelReader(db.variantVersion);
}

async function main(): Promise<void> {
  const variantReader = variantReaderFromEnv(process.env);

  const stage = await bootPilot({ startDiscovery: true, variantReader });
  process.stdout.write(
    [
      "",
      "  Maestro pilot hazır (DB-first) — model varyanttan (Studio), Jira GERÇEK, ADO sahte.",
      "",
      `  ▶ Tarayıcıdan aç:   ${stage.uiUrl}`,
      `    canlı Jira:       ${stage.jiraSite}`,
      `    sahte Azure DevOps: ${stage.adoUrl}`,
      "",
      "  Onaylar GERÇEK Jira'ya /approve yorumu yazılarak verilir. Durdurmak için Ctrl-C.",
      "",
    ].join("\n"),
  );

  install(() => stage.close());
}

if (isEntrypoint(import.meta.url)) {
  main().catch(fail);
}
