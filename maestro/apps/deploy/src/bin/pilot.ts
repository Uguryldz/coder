import { AuditChain } from "@maestro/audit";
import { bootPilot, type ListeningRule, type VariantModelReader } from "@maestro/pilot";
import { createDb } from "@maestro/db";
import { postgresChainLock, PrismaAuditStore } from "../stores/audit.js";
import { prismaTransactionRunner } from "../stores/sql.js";
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
export interface PilotDbWiring {
  variantReader: VariantModelReader;
  /**
   * The pilot's audit chain over the REAL `AuditLog` table (M33), with the
   * cross-process advisory lock — the same chain the BFF writes. Wiring it here
   * closes the worst persistence gap: without it the pilot's trail lived in an
   * `InMemoryAuditStore` and every restart erased the regulator's history.
   */
  audit: AuditChain;
  /**
   * Fire-and-forget writer landing every completed LLM call in the `LlmCall`
   * table, so the Studio cost/PII screens report the pilot's REAL spend. A DB
   * hiccup is logged and swallowed — reporting must never fail a run.
   */
  onLlmCall: (log: import("@maestro/contracts").LlmCallLog) => void;
  /**
   * Read the pilot's boot seeds from the DB: the listening rules and the
   * ENABLED "öğren" notes. Without this, a pilot restart silently forgot both
   * until someone re-saved them in Studio (the mirror is push-only).
   */
  loadSeeds: () => Promise<{
    listening: ListeningRule[];
    guidance: { title: string; content: string }[];
  }>;
}

const MATCH_KINDS = new Set(["status", "issuetype"]);
const FLOW_TYPES = new Set(["analiz", "duzeltme", "gelistirme"]);

/** Build ALL of the pilot's DB-backed wiring from one client (one URL, one pool). */
export function pilotWiringFromEnv(
  env: Record<string, string | undefined>,
  makeDb: typeof createDb = createDb,
): PilotDbWiring {
  const url = env["DATABASE_URL"]?.trim();
  if (url === undefined || url === "") {
    throw new Error(
      "DATABASE_URL is required for the DB-first pilot launcher — " +
        "run apps/pilot (main.ts) for the standalone env-fallback pilot instead.",
    );
  }
  const db = makeDb(url);
  return {
    variantReader: new PrismaVariantModelReader(db.variantVersion),
    audit: new AuditChain({
      store: new PrismaAuditStore(db.auditLog),
      lock: postgresChainLock(prismaTransactionRunner(db)),
    }),
    onLlmCall: (log) => {
      void db.llmCall
        .create({
          data: {
            at: new Date(log.at),
            runId: log.runId,
            role: log.role,
            variantId: log.variantId,
            driver: log.driver,
            model: log.model,
            tokensIn: log.tokensIn,
            tokensOut: log.tokensOut,
            cachePct: log.cachePct,
            usd: log.usd,
            dataClass: log.dataClass,
          },
        })
        .catch((error: unknown) => {
          console.warn(`[pilot] LlmCall DB yazımı başarısız (raporlama): ${String(error)}`);
        });
    },
    loadSeeds: async () => {
      const [rules, notes] = await Promise.all([
        db.listeningRule.findMany({ orderBy: { priority: "asc" } }),
        db.analysisGuidance.findMany({ where: { enabled: true }, orderBy: { updatedAt: "asc" } }),
      ]);
      return {
        // Defensive: the DB stores matchKind/flowType as free VarChar; only
        // rows the pilot's classifier understands are seeded.
        listening: rules
          .filter((r) => MATCH_KINDS.has(r.matchKind) && FLOW_TYPES.has(r.flowType))
          .map((r) => ({
            projectKey: r.projectKey,
            assigneeAccountId: r.assigneeAccountId,
            matchKind: r.matchKind as ListeningRule["matchKind"],
            matchValue: r.matchValue,
            flowType: r.flowType as ListeningRule["flowType"],
            priority: r.priority,
            enabled: r.enabled,
          })),
        guidance: notes.map((n) => ({ title: n.title, content: n.content })),
      };
    },
  };
}

/** Kept for callers/tests that only need the reader; delegates to the wiring. */
export function variantReaderFromEnv(
  env: Record<string, string | undefined>,
  makeDb: typeof createDb = createDb,
): VariantModelReader {
  return pilotWiringFromEnv(env, makeDb).variantReader;
}

async function main(): Promise<void> {
  const { variantReader, audit, onLlmCall, loadSeeds } = pilotWiringFromEnv(process.env);
  // Boot seeds from the DB (Faz 1): rules + enabled notes survive a restart.
  const seeds = await loadSeeds();

  const stage = await bootPilot({
    startDiscovery: true,
    variantReader,
    audit,
    onLlmCall,
    listening: seeds.listening,
    guidance: seeds.guidance,
  });
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
