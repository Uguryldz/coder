import type { ResolvedModel } from "@maestro/llm-gateway";

/**
 * The model the panel says this install should dial, read fresh on every call.
 *
 * THE OTHER HALF OF `connection-secrets.ts`. That file closed the gap for the
 * model's API KEY: an admin typed one into "Ayarlar & bağlantılar", and until it
 * existed the runs kept authenticating with `MAESTRO_SECRET_KV_LLM__API__2D_KEY`
 * from `.env` instead. This file closes the same gap for the three facts that
 * decide WHICH MODEL ANSWERS — the address, the model id, and whether the server
 * is inside the building.
 *
 * The panel has collected all three since the `openai_compat` kind was added.
 * `ConnectorsPanel` renders an address field, a model-name field and an optional
 * key; `runConnectionTest` dials `/v1/models` and refuses to go green when the
 * server does not serve the named model. All of that was already true and none
 * of it reached a run, because `llmConfig` read `LLM_BASE_URL`/`LLM_MODEL`
 * synchronously while composing the port. The screen said so in its own helper
 * text. This is what that text was apologising for.
 *
 * ── WHY A THUNK AND NOT A REBUILT PORT ──────────────────────────────────────
 * Same reasoning, deliberately, as the credential seam next door. Every adapter
 * resolves its token through a function invoked per request rather than a value
 * captured at boot, which is exactly why a token rotated in the panel takes
 * effect on the next call with no restart. The endpoint and the model id are
 * facts of the same kind, so they get the same treatment: `buildPortSelection`
 * stays synchronous, the registry and the frozen `packages/ports` contract stay
 * untouched, and no boot sequence learns to await a database. The alternative —
 * an async, rebuildable composition root — is the boot-time rewiring that was
 * judged too risky twice before, and it is still not performed here.
 *
 * ── NO CACHE, ON PURPOSE ────────────────────────────────────────────────────
 * Every resolution re-reads the rows. A model changed in the panel is therefore
 * live on the next call, and the alternative is the exact class of bug this
 * whole seam exists to end: an operator fixes a setting, sees nothing change,
 * and cannot tell whether they fixed the wrong thing or the platform simply did
 * not notice. It is one query on a table with a handful of rows, on a path that
 * is already about to make a network call to an inference server.
 */

/** What this resolver needs of a connection row. Structural, like every store here. */
export interface ConnectionModelRow {
  id: string;
  kind: string;
  baseUrl: string;
  secretRef: string | null;
  enabled: boolean;
  onPrem: boolean;
  isDefault: boolean;
  configJson: unknown;
}

/** The `PrismaClient.connection` methods this resolver uses — read-only. */
export interface ConnectionModelDelegate {
  findMany(args: { orderBy: { id: "asc" } }): Promise<ConnectionModelRow[]>;
}

/**
 * Connection kinds that name an inference endpoint.
 *
 * The same three the credential table already maps to `kv/llm#api-key`, and for
 * the same reason: all three speak the OpenAI protocol on the wire, which is
 * the only protocol the `openai-compat` transport can carry. A kind absent from
 * this list has no authority over which model a run dials, which is what stops
 * a future connector kind from silently becoming the platform's model.
 */
export const MODEL_CONNECTION_KINDS: readonly string[] = ["openai_compat", "openrouter", "anthropic"];

/**
 * The SecretPort reference a model connection's key answers to.
 *
 * Deliberately the SAME reference `llmConfig` has always handed the driver, so
 * `ConnectionSecretPort` keeps resolving it exactly as it does today — from the
 * panel row when one holds a token, from the environment otherwise. Introducing
 * a second reference here would have created a second place for the key to come
 * from, and two credential paths that never meet is the bug this codebase has
 * already fixed once.
 */
export const LLM_API_KEY_REF = "kv/llm#api-key";

/** Strip a trailing `/v1`: the driver appends the version segment itself. */
function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

/** The model id an operator typed, out of the row's non-secret config bag. */
function modelIdOf(configJson: unknown): string | null {
  if (typeof configJson !== "object" || configJson === null) return null;
  const model = (configJson as Record<string, unknown>)["model"];
  return typeof model === "string" && model.trim() !== "" ? model.trim() : null;
}

/**
 * Which row serves this install, or `null` when none does.
 *
 * A row qualifies only when it is ENABLED, names a model KIND, and carries a
 * model id — a connection created without one has not been finished, and
 * treating it as the active model would dial a server with no model name and
 * fail at the provider instead of here.
 *
 * Among the qualifying rows the DEFAULT wins; failing that, the first by id.
 * Ordering by id and taking the first is what makes the answer deterministic
 * when an install has several — a resolver that could pick differently between
 * two calls would produce a stack whose answering model depends on row order,
 * which is precisely what the partial unique index on `isDefault` exists to
 * prevent at the other end.
 */
export function pickModelRow(rows: readonly ConnectionModelRow[]): ConnectionModelRow | null {
  const usable = rows.filter(
    (row) => row.enabled && MODEL_CONNECTION_KINDS.includes(row.kind) && modelIdOf(row.configJson) !== null,
  );
  return usable.find((row) => row.isDefault) ?? usable[0] ?? null;
}

/**
 * Build the gateway's `resolveModel` thunk from a database client.
 *
 * Both entrypoints wire it through this one function for the same reason they
 * share `connectionSecretsFrom`: the BFF and the worker must resolve the model
 * IDENTICALLY, or the endpoint an admin tests green in the panel is not the one
 * the run dials — which is the whole split this seam was built to close.
 */
export function connectionModelFrom(db: {
  connection: ConnectionModelDelegate;
}): () => Promise<ResolvedModel | null> {
  return async () => {
    let rows: readonly ConnectionModelRow[];
    try {
      rows = await db.connection.findMany({ orderBy: { id: "asc" } });
    } catch {
      /**
       * The database is unreachable, or the table has not been migrated on a
       * stack that predates this change. Neither is a reason to fail a call the
       * ENVIRONMENT can still answer: returning null hands the decision back to
       * the static config, so a deployment that still names `LLM_BASE_URL` keeps
       * running exactly as before. An install configured only from the panel
       * reaches the not-configured refusal instead, which is the honest answer
       * for it.
       */
      return null;
    }

    const row = pickModelRow(rows);
    if (row === null) return null;
    const model = modelIdOf(row.configJson);
    if (model === null) return null;

    return {
      baseUrl: normalizeBaseUrl(row.baseUrl),
      model,
      /**
       * On-prem standing comes from the ROW, never from the URL. M18 makes this
       * the only thing between the confidential class and an outside endpoint,
       * so it must be something an operator asserted and an auditor can read.
       */
      onPrem: row.onPrem,
      apiKeyRef: LLM_API_KEY_REF,
    };
  };
}
