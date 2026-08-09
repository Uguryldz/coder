import { canonicalize } from "@maestro/audit";
import { ParamChange, type ParamDefinition } from "@maestro/contracts";
import type { PendingParamChange, ResolvedDeps } from "./deps.js";
import { badRequest, conflict, notFound } from "./errors.js";

/**
 * Operational parameters live in the database and are edited from Studio,
 * versioned and audited (M71). Some of them decide who may approve what and
 * when the flow stops; those are `guarded` and take four eyes (M32/M78) — one
 * person proposes, a DIFFERENT person confirms the exact same value.
 */

export interface ParamPutRequest {
  key: string;
  scopeRef: string | null;
  value: unknown;
  /** Audit actor of the caller; also the identity four-eyes compares. */
  actor: string;
}

export type ParamPutResult =
  | { status: "applied"; change: ParamChange }
  | { status: "pending"; pending: PendingParamChange };

export interface ParamsView {
  definitions: readonly ParamDefinition[];
  values: readonly ParamChange[];
  pending: readonly PendingParamChange[];
}

export async function readParams(deps: ResolvedDeps): Promise<ParamsView> {
  const [definitions, values, pending] = await Promise.all([
    deps.params.definitions(),
    deps.params.values(),
    deps.params.pending(),
  ]);
  return { definitions, values, pending };
}

export async function putParam(
  deps: ResolvedDeps,
  request: ParamPutRequest,
): Promise<ParamPutResult> {
  const definitions = await deps.params.definitions();
  const definition = definitions.find((candidate) => candidate.key === request.key);
  if (definition === undefined) throw notFound("unknown_param", { key: request.key });

  const typeError = checkValue(definition, request.value);
  if (typeError !== null) throw badRequest("param_value", { key: request.key, error: typeError });

  if (!definition.guarded) {
    return { status: "applied", change: await apply(deps, request, null) };
  }

  const pendingChanges = await deps.params.pending();
  const open = pendingChanges.find(
    (candidate) => candidate.key === request.key && candidate.scopeRef === request.scopeRef,
  );

  if (open === undefined) {
    const proposal: PendingParamChange = {
      key: request.key,
      scopeRef: request.scopeRef,
      value: request.value,
      proposedBy: request.actor,
      at: deps.clock.now().toISOString(),
    };
    await deps.params.putPending(proposal);
    return { status: "pending", pending: proposal };
  }

  // The proposer confirming their own proposal is one pair of eyes, however
  // many times they press the button. Re-proposing a different value simply
  // replaces the pending entry — it still waits for somebody else.
  if (open.proposedBy === request.actor) {
    const proposal: PendingParamChange = { ...open, value: request.value, at: deps.clock.now().toISOString() };
    await deps.params.putPending(proposal);
    return { status: "pending", pending: proposal };
  }

  // The second approver confirms a value, not a key: if the two do not agree
  // byte for byte, nobody has actually reviewed what is about to be written.
  if (canonicalize(open.value) !== canonicalize(request.value)) {
    throw conflict("param_value_mismatch", { key: request.key, pending: open.value });
  }

  const change = await apply(deps, { ...request, actor: open.proposedBy }, request.actor);
  await deps.params.clearPending(request.key, request.scopeRef);
  return { status: "applied", change };
}

async function apply(
  deps: ResolvedDeps,
  request: ParamPutRequest,
  approvedBy: string | null,
): Promise<ParamChange> {
  const values = await deps.params.values();
  const previous = values
    .filter((value) => value.key === request.key && value.scopeRef === request.scopeRef)
    .reduce((highest, value) => Math.max(highest, value.version), 0);

  const change = ParamChange.parse({
    key: request.key,
    scopeRef: request.scopeRef,
    value: request.value,
    version: previous + 1,
    changedBy: request.actor,
    approvedBy,
    at: deps.clock.now().toISOString(),
  });

  await deps.params.apply(change);
  await deps.audit.append({
    actor: approvedBy ?? request.actor,
    action: "PARAM_CHANGED",
    subject: `param:${request.key}`,
    at: change.at,
    meta: {
      scopeRef: request.scopeRef,
      version: change.version,
      value: request.value,
      changedBy: change.changedBy,
      approvedBy,
    },
  });
  return change;
}

/** `null` when the value fits the definition, otherwise the reason it does not. */
function checkValue(definition: ParamDefinition, value: unknown): string | null {
  switch (definition.type) {
    case "string":
      return typeof value === "string" ? null : "expected string";
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? null : "expected finite number";
    case "boolean":
      return typeof value === "boolean" ? null : "expected boolean";
    case "enum": {
      const allowed = definition.enumValues ?? [];
      if (allowed.length === 0) return "definition declares no enum values";
      return typeof value === "string" && allowed.includes(value)
        ? null
        : `expected one of ${allowed.join(", ")}`;
    }
    case "json":
      return value === undefined ? "expected a JSON value" : null;
  }
}
