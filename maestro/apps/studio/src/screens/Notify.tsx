import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ReactNode } from "react";
import { messageKeyOf } from "../api/errors.ts";
import { useApi, useAuth } from "../auth/AuthProvider.tsx";
import { hasRole } from "../auth/types.ts";
import { useT } from "../i18n/I18nProvider.tsx";
import { Badge, Button, Card, Table, useToast } from "../ui/index.ts";
import type { BadgeTone, Column } from "../ui/index.ts";
import {
  type Delegation,
  type NotifyUpdate,
  type NotifyView,
  type ParamPutResult,
  useDuration,
  type WaitingGate,
} from "./common/index.ts";
import { useEnumLabel, useLabel } from "./common/label.ts";
import { MaybeUnwired } from "./shared/unwired.tsx";
import { NotifyEditor } from "./notify/NotifyEditor.tsx";

/**
 * Reminders and escalation (M45/M88): the ladder that keeps a gate from being
 * forgotten, who a decision falls to when its owner is away, and what is
 * waiting right now.
 *
 * No rung of the ladder auto-rejects. A pause is not a decision (M29), so the
 * last step is a report to a human, never a timeout that closes the gate — the
 * screen says so, because an operator who assumes an unanswered gate eventually
 * resolves itself stops chasing it.
 */
export function NotifyScreen(): ReactNode {
  const api = useApi();
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const label = useLabel();
  const enumLabel = useEnumLabel();
  const duration = useDuration();

  const [editing, setEditing] = useState(false);

  const notify = useQuery({
    queryKey: ["notify"],
    queryFn: ({ signal }) => api.get<NotifyView>("/notify", { signal }),
  });

  const canEdit = hasRole(session, "admin");

  // PUT /notify answers `{ results: [...] }`; a guarded parameter comes back
  // `pending`, so a save is only truly applied when NONE of the results is.
  const save = useMutation({
    mutationFn: (update: NotifyUpdate) =>
      api.put<{ results: readonly ParamPutResult[] }>("/notify", update),
    onSuccess: ({ results }) => {
      setEditing(false);
      const anyPending = results.some((result) => result.status === "pending");
      if (anyPending) {
        toast.show("warning", t("notify.edit.toast.pending"));
      } else {
        void queryClient.invalidateQueries({ queryKey: ["notify"] });
        toast.show("success", t("notify.edit.toast.saved"));
      }
    },
    onError: (error) => toast.show("error", t(messageKeyOf(error))),
  });

  const delegationColumns: readonly Column<Delegation>[] = [
    { key: "role", header: t("notify.col.role"), cell: (row) => enumLabel("role", row.role).text },
    { key: "primary", header: t("notify.col.primary"), cell: (row) => row.primary },
    {
      key: "backup",
      header: t("notify.col.backup"),
      cell: (row) => row.backup ?? <span className="scr-mini">{t("notify.value.none")}</span>,
    },
    {
      key: "last",
      header: t("notify.col.last_resort"),
      cell: (row) => row.lastResort ?? <span className="scr-mini">{t("notify.value.none")}</span>,
    },
  ];

  const waitingColumns: readonly Column<WaitingGate>[] = [
    {
      key: "ticket",
      header: t("notify.col.ticket"),
      cell: (row) => <b className="scr-mono">{row.ticketKey}</b>,
    },
    {
      key: "step",
      header: t("notify.col.step"),
      cell: (row) => label(`notify.step.${row.step}`, row.step),
    },
    {
      key: "waiting",
      header: t("notify.col.waiting"),
      cell: (row) => (
        <Badge tone={waitingTone(row.waitingHours)}>{duration(row.waitingHours)}</Badge>
      ),
      align: "right",
    },
    {
      key: "last_action",
      header: t("notify.col.last_action"),
      cell: (row) => (
        <span className="scr-mini">
          {row.lastActionKey === null
            ? "—"
            : label(row.lastActionKey, "—", row.lastActionParams ?? {})}
        </span>
      ),
    },
  ];

  return (
    <div className="scr-stack">
      {/* `GET /notify` is not built yet — see MaybeUnwired. */}
      <MaybeUnwired
        isPending={notify.isPending}
        error={notify.error}
        onRetry={() => void notify.refetch()}
      >
        <Card
          title={t("notify.card.ladder")}
          subtitle={t("notify.card.ladder_sub")}
          actions={
            canEdit && notify.data !== undefined ? (
              <Button size="sm" variant="primary" onClick={() => setEditing(true)}>
                {t("notify.edit.action")}
              </Button>
            ) : undefined
          }
        >
          {(notify.data?.ladder ?? []).length === 0 ? (
            <p className="scr-mini">{t("notify.empty.ladder")}</p>
          ) : (
            <div className="scr-ladder">
              {(notify.data?.ladder ?? []).map((step, index) => (
                <span key={`${step.kind}-${step.afterHours}`} className="scr-row">
                  {index > 0 && <span className="scr-arrow">→</span>}
                  <span
                    className={
                      step.kind === "notify" ? "scr-step scr-step--on" : "scr-step scr-step--pending"
                    }
                  >
                    {t(`notify.ladder.${step.kind}`, {
                      hours: String(step.afterHours),
                      channels: step.channels
                        .map((channel) => label(`notify.channel.${channel}`, channel))
                        .join(" + "),
                    })}
                  </span>
                </span>
              ))}
            </div>
          )}
          <div className="scr-note" style={{ marginTop: 12 }}>
            {t("notify.note.no_auto_reject")}
          </div>
        </Card>

        <div className="scr-grid scr-grid--2">
          <Card title={t("notify.card.delegation")} subtitle={t("notify.card.delegation_sub")} padded={false}>
            <Table
              columns={delegationColumns}
              rows={notify.data?.delegations ?? []}
              rowKey={(row) => row.role}
              emptyLabel={t("notify.empty.delegation")}
              caption={t("notify.card.delegation")}
            />
          </Card>

          <Card title={t("notify.card.waiting")} subtitle={t("notify.card.waiting_sub")} padded={false}>
            <Table
              columns={waitingColumns}
              rows={notify.data?.waiting ?? []}
              rowKey={(row) => `${row.ticketKey}:${row.step}`}
              emptyLabel={t("notify.empty.waiting")}
              caption={t("notify.card.waiting")}
            />
          </Card>
        </div>
      </MaybeUnwired>

      {notify.data !== undefined && (
        <NotifyEditor
          open={editing}
          ladder={notify.data.ladderRaw}
          routing={notify.data.routing}
          busy={save.isPending}
          onClose={() => setEditing(false)}
          onSubmit={(update) => save.mutate(update)}
        />
      )}
    </div>
  );
}

/** Colour by how long somebody has been waiting: a day, three days, longer. */
function waitingTone(hours: number): BadgeTone {
  if (hours >= 168) return "red";
  if (hours >= 72) return "amber";
  return "gray";
}
