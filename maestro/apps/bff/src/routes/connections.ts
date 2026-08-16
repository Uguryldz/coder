import { randomBytes } from "node:crypto";
import { ConnectionId, ConnectionInput } from "@maestro/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sessionActor } from "../actor.js";
import { authGuard, requireAnyRole, sessionOf } from "../auth/guard.js";
import type { ConnectionRecord, ConnectionStore } from "../connection-store.js";
import {
  maskToken,
  runConnectionTest,
  toConnectionRecord,
  toConnectionView,
} from "../connection-service.js";
import type { ResolvedDeps } from "../deps.js";
import { badRequest, notFound } from "../errors.js";
import type { SecretPort } from "@maestro/ports";
import { assertWritable } from "../platform/propose.js";
import { unwired } from "./unwired.js";

/**
 * The connector-management surface (installable-product wiring).
 *
 * The platform's outbound connections (Jira, GitHub, the LLM, Vault) become
 * admin-editable here: an admin enters a URL + token, tests it LIVE, and the
 * token is stored AES-encrypted and only ever read back as a four-character
 * mask. Everything that could leak a secret is designed against:
 *
 *  · A raw token appears only on the INBOUND `ConnectionInput.token`; no GET
 *    returns it, because the read shape (`Connection`) has no token field.
 *  · The live test uses the STORED credential, never one on the test request:
 *    a viewer cannot hand a token to `/test` and have it POSTed to a URL they
 *    chose. (They also cannot reach the route — it is admin-gated.)
 *  · Every write/test/delete is admin-only at the BFF (M86), independent of
 *    what Studio shows.
 *  · Reads are admin + tech-lead, the same audience as the settings screen.
 *
 * A test failure is reported as a failure — there is no shape here that fakes a
 * green light, and `lastTestOk` is recorded from the real outcome.
 */

const READ_ROLES = ["admin", "tech-lead"] as const;
const WRITE_ROLES = ["admin"] as const;

/** The `:id` path param — the same grammar the contract's `ConnectionId` uses. */
const IdParam = z.object({ id: ConnectionId });

/**
 * Both halves the connector routes need, or neither. The store persists the
 * connection; the SecretPort enciphers the token. A deployment that wired one
 * but not the other could store a connection it can never decrypt a token for,
 * so the routes demand the pair and otherwise refuse by name.
 */
function connectorDeps(deps: ResolvedDeps): { store: ConnectionStore; secrets: SecretPort } {
  if (deps.connections === undefined || deps.connectorSecrets === undefined) unwired("connections");
  return { store: deps.connections, secrets: deps.connectorSecrets };
}

export async function connectionRoutes(app: FastifyInstance, deps: ResolvedDeps): Promise<void> {
  const readHandler = [authGuard(deps), requireAnyRole(...READ_ROLES)];
  const writeHandler = [authGuard(deps), requireAnyRole(...WRITE_ROLES)];

  /** List every connection, masked. Never a token — only the mask + a set flag. */
  app.get("/studio/connections", { preHandler: readHandler }, async (_request, reply) => {
    const { store } = connectorDeps(deps);
    const rows = await store.list();
    return reply.code(200).send({ connections: rows.map(toConnectionView) });
  });

  /** Create a connection. Zod-validated; a new token is enciphered, never stored raw. */
  app.post("/studio/connections", { preHandler: writeHandler }, async (request, reply) => {
    await assertWritable(deps);
    const { store, secrets } = connectorDeps(deps);

    const id = ConnectionId.safeParse((request.body as { id?: unknown } | null)?.id);
    if (!id.success) throw badRequest("invalid_connection_id");
    const body = ConnectionInput.safeParse(request.body);
    if (!body.success) throw badRequest("invalid_connection_body");

    if ((await store.get(id.data)) !== null) throw badRequest("connection_exists");

    const now = deps.clock.now().toISOString();
    const secret = await storeToken(secrets, id.data, body.data.token, null);
    const record = toConnectionRecord(id.data, body.data, secret, {
      createdAt: now,
      updatedAt: now,
      lastTestedAt: null,
      lastTestOk: null,
    });
    await store.put(record);
    await audit(deps, request, id.data, "created");
    return reply.code(201).send({ connection: toConnectionView(record) });
  });

  /** Update a connection. A new token replaces the old ref; an absent token keeps it. */
  app.put("/studio/connections/:id", { preHandler: writeHandler }, async (request, reply) => {
    await assertWritable(deps);
    const { store, secrets } = connectorDeps(deps);

    const params = IdParam.safeParse(request.params);
    if (!params.success) throw badRequest("invalid_connection_id");
    const body = ConnectionInput.safeParse(request.body);
    if (!body.success) throw badRequest("invalid_connection_body");

    const existing = await store.get(params.data.id);
    if (existing === null) throw notFound("no_such_connection");

    const secret = await storeToken(secrets, params.data.id, body.data.token, existing);
    // A learned `botAccountId` SURVIVES an edit that does not carry one. The
    // panel's modal round-trips `config` verbatim, so a plain rename or URL fix
    // would otherwise write back whatever the form was opened with — which is
    // how a hand-typed wrong id outlived every correction the test made. A body
    // that DOES carry the key still wins; this only refuses to lose the value.
    const merged = mergeLearnedIdentity(body.data, existing);
    const record = toConnectionRecord(params.data.id, merged, secret, {
      createdAt: existing.createdAt,
      updatedAt: deps.clock.now().toISOString(),
      // An edit does not un-test the connection; the test result (and its note)
      // stand until a new test overwrites them.
      lastTestedAt: existing.lastTestedAt,
      lastTestOk: existing.lastTestOk,
      lastTestNote: existing.lastTestNote,
    });
    await store.put(record);
    await audit(deps, request, params.data.id, "updated");
    return reply.code(200).send({ connection: toConnectionView(record) });
  });

  /**
   * The LIVE test. Reads the STORED token (never one from the request), calls
   * the target, records the honest outcome, and returns ok/fail + a catalog key.
   */
  app.post("/studio/connections/:id/test", { preHandler: writeHandler }, async (request, reply) => {
    const { store, secrets } = connectorDeps(deps);

    const params = IdParam.safeParse(request.params);
    if (!params.success) throw badRequest("invalid_connection_id");
    const record = await store.get(params.data.id);
    if (record === null) throw notFound("no_such_connection");

    // The token is fetched here and passed to the test; it is never logged and
    // never returned. A connection with no secretRef tests as "no token".
    const token = record.secretRef === null ? null : await readToken(secrets, record.secretRef);
    const outcome = await runConnectionTest(
      record,
      token,
      deps.connectorFetch,
      deps.config.engineBotAccountId,
    );

    const at = deps.clock.now().toISOString();

    // A successful Jira test learned the bot's own accountId. Persist it in the
    // connection's (non-secret) config so a listening rule can offer "the bot"
    // by name instead of asking an operator to hand-copy a 40-char GUID. Only on
    // success and only when it changed, so a failed test never wipes a good value.
    //
    // This is the SELF-HEAL, and it is deliberately automatic: the live answer
    // is authoritative (the token's own owner), whereas the stored value is a
    // hand-typed 36-char id — believing the keyboard over the API would keep a
    // known-wrong account in place. What changed is never silent, though: the
    // outcome carries `ok_bot_fixed` so the panel names both ids, and the audit
    // row records the replacement rather than a plain "test_ok".
    //
    // It runs BEFORE `recordTest`: `put` writes the whole row from the record
    // read at the top of the handler, which still carries the PREVIOUS test
    // result — healing afterwards would erase the verdict just recorded.
    if (outcome.ok && outcome.accountId && record.config["botAccountId"] !== outcome.accountId) {
      await store.put({
        ...record,
        config: { ...record.config, botAccountId: outcome.accountId },
        updatedAt: at,
      });
    }

    // `outcome.messageKey` is a catalog KEY (e.g. "connection.test.unauthorized"),
    // never raw text — safe to persist as the row's secret-free test note.
    await store.recordTest(record.id, { at, ok: outcome.ok, note: outcome.messageKey });
    const verb = outcome.ok
      ? outcome.accountIdCorrected === undefined
        ? "test_ok"
        : "test_ok_bot_corrected"
      : "test_fail";
    await audit(deps, request, record.id, verb, {
      // The displaced id and its replacement — opaque account ids, never an
      // email, so the audit trail can answer "whose account was this?" later.
      ...(outcome.accountIdCorrected === undefined
        ? {}
        : { botAccountIdWas: outcome.accountIdCorrected.from, botAccountIdNow: outcome.accountId }),
      // A split identity is recorded even though the test passed: it is the
      // condition under which every rule built from this connection is dead, so
      // the trail must show WHEN it started and when it stopped, not just that
      // somebody once tested the connection successfully.
      ...(outcome.engineMismatch === undefined
        ? {}
        : {
            engineMismatchConnection: outcome.engineMismatch.connection,
            engineMismatchEngine: outcome.engineMismatch.engine,
          }),
    });

    return reply.code(200).send({
      ok: outcome.ok,
      messageKey: outcome.messageKey,
      ...(outcome.messageParams === undefined ? {} : { messageParams: outcome.messageParams }),
      testedAt: at,
      // Account ids only — `/myself` also returns an email, which never travels.
      ...(outcome.accountIdCorrected === undefined || outcome.accountId === undefined
        ? {}
        : { botAccountCorrected: { from: outcome.accountIdCorrected.from, to: outcome.accountId } }),
      // The identity split, as structured data beside the sentence — the panel
      // renders it as a warning without having to parse the message.
      ...(outcome.engineMismatch === undefined ? {} : { engineMismatch: outcome.engineMismatch }),
    });
  });

  /** Delete a connection and its secret. */
  app.delete("/studio/connections/:id", { preHandler: writeHandler }, async (request, reply) => {
    await assertWritable(deps);
    const { store, secrets } = connectorDeps(deps);

    const params = IdParam.safeParse(request.params);
    if (!params.success) throw badRequest("invalid_connection_id");

    const removed = await store.remove(params.data.id);
    if (removed === null) throw notFound("no_such_connection");
    // Drop the enciphered secret too — a connection deleted with its token left
    // behind is an orphaned credential nobody can see but that still exists.
    if (removed.secretRef !== null) await deleteToken(secrets, removed.secretRef);
    await audit(deps, request, params.data.id, "deleted");
    return reply.code(204).send();
  });
}

/**
 * Carry a learned `botAccountId` across an edit that omits it.
 *
 * The value is not operator data — it is what the live `/myself` probe read back
 * from the token itself. An edit whose `config` simply has no such key must not
 * be read as "clear it"; only a body that actually names the key may change it.
 */
function mergeLearnedIdentity(input: ConnectionInput, existing: ConnectionRecord): ConnectionInput {
  const learned = existing.config["botAccountId"];
  if (learned === undefined || input.config["botAccountId"] !== undefined) return input;
  return { ...input, config: { ...input.config, botAccountId: learned } };
}

/**
 * Encipher a new token, returning the reference + mask to store on the row.
 *
 * `undefined` token = "leave the existing secret alone" (a config-only edit):
 * the previous ref/mask are carried forward. A present token is enciphered
 * under a fresh reference (rotating the secret) and masked to its last four
 * chars. The plaintext is never stored on the connection and never logged.
 */
async function storeToken(
  secrets: SecretPort,
  connectionId: string,
  token: string | undefined,
  existing: ConnectionRecord | null,
): Promise<{ ref: string | null; mask: string | null }> {
  if (token === undefined) {
    return existing === null
      ? { ref: null, mask: null }
      : { ref: existing.secretRef, mask: existing.secretMask };
  }
  // A RANDOM suffix, not a timestamp: two rotations in the same millisecond
  // would collide on a `Date.now()` ref and the second write would overwrite the
  // first secret's slot instead of taking a new one. `randomBytes` makes each
  // rotation a fresh, unguessable slot.
  const ref = `connector:${connectionId}:${randomBytes(6).toString("hex")}`;
  await secrets.set(ref, token);
  return { ref, mask: maskToken(token) };
}

/** Decrypt the stored token for a live test. Its value never leaves this call. */
async function readToken(secrets: SecretPort, ref: string): Promise<string | null> {
  try {
    return await secrets.get(ref);
  } catch {
    // A ref with no secret (a hand-broken row) tests as "no token" rather than
    // taking the endpoint down.
    return null;
  }
}

/** Best-effort secret removal on delete. */
async function deleteToken(secrets: SecretPort, ref: string): Promise<void> {
  const candidate = secrets as SecretPort & { delete?: (key: string) => Promise<void> };
  if (typeof candidate.delete === "function") await candidate.delete(ref);
}

/**
 * The audit row for a connector change. Uses `PARAM_CHANGED` — a connector is
 * platform configuration in the same governance category — and carries the
 * connection id and the verb, never the token or the URL's credentials.
 */
async function audit(
  deps: ResolvedDeps,
  request: Parameters<typeof sessionOf>[0],
  connectionId: string,
  verb: string,
  extra: Record<string, string> = {},
): Promise<void> {
  await deps.audit.append({
    actor: sessionActor(sessionOf(request)),
    action: "PARAM_CHANGED",
    subject: `connection:${connectionId}`,
    at: deps.clock.now(),
    meta: { surface: "connections", verb, ...extra },
  });
}
