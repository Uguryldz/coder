import type { AuditAction, JournalActor, JournalKind, NotifyEventKey } from "@maestro/contracts";
import { appendJournal } from "@maestro/memory";
import { routeNotification } from "@maestro/notify";
import { type ActivityDeps, type RunContext, WORKER_ACTOR } from "./deps.js";

/**
 * The three records every activity leaves behind: the ticket journal (M30,
 * masked at the boundary — M82), the hash-chained audit trail (M33) and the
 * notification (M45/M104).
 *
 * They are here rather than inlined so that "did this activity leave a trace?"
 * is answerable by reading one file, and so a retry cannot write the journal
 * twice: every caller passes an idempotency key.
 */

/**
 * Append one journal entry. `appendJournal` masks the text before it is sealed
 * (M82) and refuses to update or delete anything, so this is append-only by
 * construction.
 */
export async function record(
  deps: ActivityDeps,
  run: RunContext,
  args: {
    kind: JournalKind;
    title: string;
    detail?: string;
    actor?: JournalActor;
    /** Discriminator inside the run; the guard replays instead of duplicating. */
    key: string;
  },
): Promise<void> {
  await deps.idempotency.once(`${run.runId}:journal:${args.key}`, async () => {
    await appendJournal(deps.memory, {
      runId: run.runId,
      actor: args.actor ?? "system",
      kind: args.kind,
      title: args.title,
      detail: args.detail ?? "",
    });
  });
}

/**
 * Append one audit record. The chain is hash-linked, so a duplicate is not
 * merely noise — it is a second record claiming the same predecessor, which
 * the store rejects. The guard is what keeps a retried activity from tripping
 * that rejection.
 */
export async function audit(
  deps: ActivityDeps,
  run: RunContext,
  args: {
    action: AuditAction;
    /** Human actor for gate records (M32/M101); the worker for everything else. */
    actor?: string;
    subject?: string;
    meta?: Record<string, unknown>;
    key: string;
  },
): Promise<void> {
  await deps.idempotency.once(`${run.runId}:audit:${args.key}`, async () => {
    await deps.audit.append({
      actor: args.actor ?? WORKER_ACTOR,
      action: args.action,
      subject: args.subject ?? run.ticket,
      meta: { runId: run.runId, ...args.meta },
    });
  });
}

/**
 * Send one notification over every channel the routing parameter maps the
 * event to (M45/M71). A muted event is recorded in the journal rather than
 * dropped: "nobody was told, on purpose" and "nobody was told" must not look
 * the same afterwards.
 */
export async function notifyEvent(
  deps: ActivityDeps,
  run: RunContext,
  args: {
    event: NotifyEventKey;
    messageKey: string;
    params: Record<string, string>;
    to: readonly string[];
    key: string;
  },
): Promise<void> {
  if (args.to.length === 0) return;
  const routing = await deps.params.notifyRouting(run.runId);
  const routed = routeNotification(routing, {
    event: args.event,
    to: [...args.to],
    locale: run.locale,
    messageKey: args.messageKey,
    params: args.params,
    at: deps.now().toISOString(),
  });
  if (routed.muted) {
    await record(deps, run, {
      kind: "other",
      title: "bildirim susturuldu",
      detail: `${args.event} (notify.routing)`,
      key: `mute:${args.key}`,
    });
    return;
  }
  for (const notification of routed.notifications) {
    await deps.idempotency.once(
      `${run.runId}:notify:${args.key}:${notification.channel}`,
      () => deps.notify.send(notification),
    );
  }
}
