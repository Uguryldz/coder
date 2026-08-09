import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useApi } from "../auth/AuthProvider.tsx";
import { useT } from "../i18n/I18nProvider.tsx";
import { Badge, Card, Table } from "../ui/index.ts";
import type { BadgeTone, Column } from "../ui/index.ts";
import {
  type Delegation,
  type NotifyView,
  QueryState,
  useDuration,
  type WaitingGate,
} from "./common/index.ts";
import { useLabel } from "./common/label.ts";

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
  const label = useLabel();
  const duration = useDuration();

  const notify = useQuery({
    queryKey: ["notify"],
    queryFn: ({ signal }) => api.get<NotifyView>("/notify", { signal }),
  });

  const delegationColumns: readonly Column<Delegation>[] = [
    { key: "role", header: t("notify.col.role"), cell: (row) => t(`role.${row.role}`) },
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
      <QueryState
        isPending={notify.isPending}
        error={notify.error}
        onRetry={() => void notify.refetch()}
      >
        <Card title={t("notify.card.ladder")} subtitle={t("notify.card.ladder_sub")}>
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
      </QueryState>
    </div>
  );
}

/** Colour by how long somebody has been waiting: a day, three days, longer. */
function waitingTone(hours: number): BadgeTone {
  if (hours >= 168) return "red";
  if (hours >= 72) return "amber";
  return "gray";
}
