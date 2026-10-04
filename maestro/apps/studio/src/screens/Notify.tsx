import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ReactNode } from "react";
import { messageKeyOf } from "../api/errors.ts";
import { useApi, useAuth } from "../auth/AuthProvider.tsx";
import { hasRole } from "../auth/types.ts";
import { useT } from "../i18n/I18nProvider.tsx";
import { Badge, Button, Card, Input, Table, useToast } from "../ui/index.ts";
import type { BadgeTone, Column } from "../ui/index.ts";
import {
  type Delegation,
  NOTIFY_EVENTS,
  type NotifyChannel,
  type NotifyDriver,
  type NotifyUpdate,
  type NotifyView,
  type ParamPutResult,
  useDuration,
  type WaitingGate,
} from "./common/index.ts";
import { useEnumLabel, useLabel } from "./common/label.ts";
import { NotifyEditor } from "./notify/NotifyEditor.tsx";
import { QueryState } from "./shared/QueryState.tsx";

/**
 * `GET /notify` also carries the deployment's notify drivers — the same rows
 * `/settings` reports — so which channels actually deliver is read from the
 * runtime. Optional on the type: an older BFF omits it, and then the screen
 * simply does not claim to know.
 */
type NotifyViewWire = NotifyView & { readonly drivers?: readonly NotifyDriver[] };

/**
 * Reminders and escalation: the ladder that keeps a gate from being forgotten,
 * who a decision falls to when its owner is away, and what is waiting right now.
 *
 * No rung of the ladder auto-rejects. A pause is not a decision, so the last
 * step is a report to a human, never a timeout that closes the gate — the
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
    queryFn: ({ signal }) => api.get<NotifyViewWire>("/notify", { signal }),
  });

  // The BFF writes `/notify` for admin only (SETTINGS_WRITE_ROLES); tech-lead
  // reads. The menu shows the page to both, the buttons only to the writer.
  const canEdit = hasRole(session, "admin");

  // PUT /notify answers `{ results: [...] }`; a guarded parameter comes back
  // `pending`, so a save is only truly applied when NONE of the results is.
  const save = useMutation({
    mutationFn: (update: NotifyUpdate) =>
      api.put<{ results: readonly ParamPutResult[] }>("/notify", update),
    onSuccess: ({ results }) => {
      setEditing(false);
      void queryClient.invalidateQueries({ queryKey: ["notify"] });
      const anyPending = results.some((result) => result.status === "pending");
      toast.show(
        anyPending ? "warning" : "success",
        t(anyPending ? "notify.edit.toast.pending" : "notify.edit.toast.saved"),
      );
    },
    onError: (error) => toast.show("error", t(messageKeyOf(error))),
  });

  const data = notify.data;
  // Which channels deliver in THIS deployment, from the runtime's driver list.
  // `null` = the BFF did not say (older build), and then no channel is marked
  // either way rather than guessed.
  const liveChannels: ReadonlySet<string> | null =
    data?.drivers === undefined
      ? null
      : new Set(data.drivers.filter((driver) => driver.enabled).map((driver) => driver.channel));

  const channelBadge = (channel: NotifyChannel): ReactNode => {
    const live = liveChannels === null ? null : liveChannels.has(channel);
    return (
      <Badge key={channel} tone={live === false ? "gray" : "green"}>
        {label(`notify.channel.${channel}`, channel)}
        {live === false ? ` · ${t("notify.routing.pasif")}` : ""}
      </Badge>
    );
  };

  const routingColumns: readonly Column<{
    event: string;
    channels: readonly NotifyChannel[];
    explicit: boolean;
  }>[] = [
    {
      key: "event",
      header: t("notify.col.event"),
      cell: (row) => (
        <div>
          <b>{label(`notify.event.${row.event}`, row.event)}</b>
          {!row.explicit && <span className="scr-mini"> · {t("notify.routing.uses_default")}</span>}
        </div>
      ),
    },
    {
      key: "channels",
      header: t("notify.col.channels"),
      cell: (row) =>
        row.channels.length === 0 ? (
          <Badge tone="gray">{t("notify.routing.muted")}</Badge>
        ) : (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {row.channels.map(channelBadge)}
          </div>
        ),
    },
  ];

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

  // One editor, two doors — each named for the card it sits on. The routing
  // card's button says "Eşlemeyi düzenle", the ladder's "Merdiveni düzenle";
  // three identical "Merdiveni düzenle" buttons on unrelated cards read as a
  // mistake. The delegation card has none: the editor does not change deputies.
  const editButton = (labelKey: "notify.routing.edit" | "notify.edit.action"): ReactNode =>
    canEdit && data !== undefined ? (
      <Button size="sm" variant="primary" onClick={() => setEditing(true)}>
        {t(labelKey)}
      </Button>
    ) : undefined;

  return (
    <div className="scr-stack">
      <p className="scr-hint">{t("notify.intro.body")}</p>

      <QueryState
        isPending={notify.isPending}
        error={notify.error}
        onRetry={() => void notify.refetch()}
      >
        {/* Which event goes to which channel — the most-asked question, so it
            leads. A blank entry follows `default`; an empty list is muted
            DELIBERATELY. */}
        {/* The master switch first: "bildirim gelmiyor" and "bildirim
            istemiyorum" both start here. Off = the engine sends to no channel
            and journals "bildirim kapalı"; gates and comments are unaffected. */}
        {data !== undefined && (
          <Card title={t("notify.enabled.title")}>
            <label className="scr-check">
              <input
                type="checkbox"
                checked={data.enabled !== false}
                disabled={!canEdit || save.isPending}
                onChange={(event) => save.mutate({ enabled: event.target.checked })}
              />
              {t("notify.enabled.toggle")}
            </label>
            <p className={data.enabled === false ? "scr-hint scr-hint--warn" : "scr-hint"}>
              {t(data.enabled === false ? "notify.enabled.off" : "notify.enabled.on")}
            </p>
          </Card>
        )}
        {data !== undefined && (
          <Card
            title={t("notify.card.routing")}
            subtitle={t("notify.card.routing_sub")}
            actions={editButton("notify.routing.edit")}
            padded={false}
          >
            <Table
              columns={routingColumns}
              rows={NOTIFY_EVENTS.map((event) => ({
                event,
                channels: data.routing.byEvent[event] ?? data.routing.default,
                explicit: data.routing.byEvent[event] !== undefined,
              }))}
              rowKey={(row) => row.event}
              emptyLabel=""
              caption={t("notify.card.routing")}
            />
            <p className="scr-hint" style={{ margin: "10px 14px 12px" }}>
              {liveChannels === null
                ? t("notify.routing.channel_status_unknown")
                : t("notify.routing.channel_status")}
            </p>
          </Card>
        )}

        {/* Approvals waiting right now. */}
        <Card title={t("notify.card.waiting")} subtitle={t("notify.card.waiting_sub")} padded={false}>
          <Table
            columns={waitingColumns}
            rows={data?.waiting ?? []}
            rowKey={(row) => `${row.ticketKey}:${row.step}`}
            emptyLabel={t("notify.empty.waiting")}
            caption={t("notify.card.waiting")}
          />
        </Card>

        {/* The reminder ladder — how a long-waiting approval escalates. */}
        <Card title={t("notify.card.ladder")} subtitle={t("notify.card.ladder_sub")} actions={editButton("notify.edit.action")}>
          {(data?.ladder ?? []).length === 0 ? (
            <p className="scr-mini">{t("notify.empty.ladder")}</p>
          ) : (
            <div className="scr-ladder">
              {(data?.ladder ?? []).map((step, index) => (
                <span key={`${step.kind}-${step.afterHours}`} className="scr-row">
                  {index > 0 && <span className="scr-arrow">→</span>}
                  <span
                    className={
                      step.kind === "notify" ? "scr-step scr-step--on" : "scr-step scr-step--pending"
                    }
                  >
                    {t(`notify.ladder.${step.kind}`, {
                      days: humanDays(step.afterHours, t),
                      channels: step.channels
                        .map((channel) => label(`notify.channel.${channel}`, channel))
                        .join(" + "),
                    })}
                  </span>
                </span>
              ))}
            </div>
          )}
          <p className="scr-hint" style={{ marginTop: 10 }}>{t("notify.note.no_auto_reject")}</p>
        </Card>

        {/* The deputy chain — who a stuck approval falls to. It is the audience
            of the ladder's "delegate" rung; read-only here, the editor does not
            change it. */}
        <Card title={t("notify.card.delegation")} subtitle={t("notify.card.delegation_sub")} padded={false}>
          <Table
            columns={delegationColumns}
            rows={data?.delegations ?? []}
            rowKey={(row) => row.role}
            emptyLabel={t("notify.empty.delegation")}
            caption={t("notify.card.delegation")}
          />
        </Card>

        {/* The Teams webhook entry (admin only) — belongs with channel setup. */}
        {data !== undefined && canEdit && (
          <TeamsWebhookCard
            mask={data.teamsWebhookMask}
            busy={save.isPending}
            onSave={(url) => save.mutate({ teamsWebhook: url })}
          />
        )}
      </QueryState>

      {data !== undefined && (
        <NotifyEditor
          open={editing}
          ladder={data.ladderRaw}
          routing={data.routing}
          liveChannels={liveChannels}
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

/**
 * A ladder threshold as a plain phrase: whole days read as "N gün", anything
 * else stays in hours. The ladder steps at 24/72/168h become "1 gün / 3 gün /
 * 7 gün" — the reading an operator has, not the raw hour count.
 */
function humanDays(hours: number, t: (key: string, params?: Record<string, string>) => string): string {
  if (hours % 24 === 0) {
    const days = hours / 24;
    return t("notify.duration.days", { n: String(days) });
  }
  return t("notify.duration.hours", { n: String(hours) });
}

/**
 * The Teams webhook URL entry. The full URL is a bearer credential, so the
 * field starts EMPTY showing only the stored mask ("…<last 6>"); the admin types
 * a new URL to change it, and an empty submit clears it. The URL is never fetched
 * back to prefill — the server only ever hands out the mask.
 */
function TeamsWebhookCard({
  mask,
  busy,
  onSave,
}: {
  readonly mask: string;
  readonly busy: boolean;
  readonly onSave: (url: string) => void;
}): ReactNode {
  const t = useT();
  const [url, setUrl] = useState("");
  const isSet = mask !== "";
  return (
    <Card title={t("notify.teams.title")} subtitle={t("notify.teams.sub")}>
      <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 320px" }}>
          <Input
            label={t("notify.teams.field")}
            type="password"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder={isSet ? `${t("notify.teams.current")}: ${mask}` : "https://…webhook…"}
            hint={t("notify.teams.hint")}
          />
        </div>
        <Button variant="primary" busy={busy} onClick={() => onSave(url.trim())}>
          {t("notify.teams.save")}
        </Button>
        {isSet && (
          <Button busy={busy} onClick={() => onSave("")}>
            {t("notify.teams.clear")}
          </Button>
        )}
      </div>
    </Card>
  );
}
