import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useApi } from "../auth/AuthProvider.tsx";
import { useT } from "../i18n/I18nProvider.tsx";
import { Badge, Card, Table } from "../ui/index.ts";
import type { BadgeTone, Column } from "../ui/index.ts";
import {
  type Connection,
  type ConnectionStatus,
  type NotifyDriver,
  type SettingsView,
} from "./common/index.ts";
import { useEnumLabel, useLabel } from "./common/label.ts";
import { QueryState } from "./common/index.ts";
import { ConnectorsPanel } from "./settings/ConnectorsPanel.tsx";
import { KillSwitchPanel } from "./settings/KillSwitchPanel.tsx";

const STATUS_TONE: Readonly<Record<ConnectionStatus, BadgeTone>> = {
  connected: "green",
  degraded: "amber",
  unconfigured: "gray",
};

/**
 * Platform wiring: the outbound connections (Jira, ADO, Vault, storage, SIEM,
 * proxy, directory), the notify drivers, and the kill switch.
 *
 * `credentialRef` is a Vault path or an auth method, never a secret. The BFF
 * must not send one and this screen never asks for one — a console that can
 * display a PAT is a console that can leak it into a screenshot.
 */
export function SettingsScreen(): ReactNode {
  const api = useApi();
  const t = useT();
  const label = useLabel();
  const enumLabel = useEnumLabel();

  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: ({ signal }) => api.get<SettingsView>("/settings", { signal }),
  });

  const connectionColumns: readonly Column<Connection>[] = [
    {
      key: "id",
      header: t("settings.col.connection"),
      cell: (row) => (
        <div>
          <b>{label(`settings.connection.${row.id}`, row.id)}</b>
          <div className="scr-mono scr-mini">{row.endpoint}</div>
        </div>
      ),
    },
    {
      key: "status",
      header: t("settings.col.status"),
      cell: (row) => {
        const status = enumLabel("settings.status", row.status);
        return (
          <Badge tone={status.unknown ? "gray" : STATUS_TONE[row.status]} icon="●">
            {status.text}
          </Badge>
        );
      },
    },
    {
      key: "credential",
      header: t("settings.col.credential"),
      cell: (row) => <span className="scr-mono scr-mini">{row.credentialRef}</span>,
    },
  ];

  const driverColumns: readonly Column<NotifyDriver>[] = [
    {
      key: "channel",
      header: t("settings.col.channel"),
      cell: (row) => label(`notify.channel.${row.channel}`, row.channel),
    },
    {
      key: "enabled",
      header: t("settings.col.status"),
      cell: (row) => (
        <Badge tone={row.enabled ? "green" : "gray"}>
          {t(row.enabled ? "settings.driver.enabled" : "settings.driver.disabled")}
        </Badge>
      ),
    },
    {
      key: "target",
      header: t("settings.col.target"),
      cell: (row) => <span className="scr-mini">{row.target}</span>,
    },
  ];

  return (
    <div className="scr-stack">
      {/*
        The connector-management surface: the platform's outbound connections
        made ADMIN-EDITABLE (Connection / ConnectorSecret, migration 0010).
        Distinct from the read-only "deployment facts" table below — that one
        reports an endpoint and a Vault credential reference the platform was
        DEPLOYED with; this one lets an admin add a connection, enter a token
        (stored AES-encrypted, shown masked), and test it live. The panel is
        admin/tech-lead readable and admin-editable; the BFF enforces both.
      */}
      <ConnectorsPanel />

      {/*
        `GET /settings` is LIVE (apps/bff/src/routes/settings.ts). A failure here
        is a real failure, so it renders through the ordinary error path rather
        than the "not published yet" fallback that guarded this screen while the
        endpoint was still a request.

        The connections and notify drivers are DEPLOYMENT FACTS — an endpoint and
        a Vault credential reference, read from the environment and the probes —
        so they are shown, not edited: PUT /settings edits the operational
        parameter set (the /params screen), and `credentialRef` never carries a
        secret a console could leak. The one control this screen owns outright is
        the kill switch below.
      */}
      <QueryState
        isPending={settings.isPending}
        error={settings.error}
        onRetry={() => void settings.refetch()}
        skeletonRows={4}
      >
        <Card
          title={t("settings.card.connections")}
          subtitle={t("settings.card.connections_sub")}
          padded={false}
        >
          <Table
            columns={connectionColumns}
            rows={settings.data?.connections ?? []}
            rowKey={(row) => row.id}
            emptyLabel={t("settings.empty.connections")}
            caption={t("settings.card.connections")}
          />
        </Card>

        <Card
          title={t("settings.card.notify")}
          subtitle={t("settings.card.notify_sub")}
          padded={false}
        >
          <Table
            columns={driverColumns}
            rows={settings.data?.notifyDrivers ?? []}
            rowKey={(row) => row.channel}
            emptyLabel={t("settings.empty.notify")}
            caption={t("settings.card.notify")}
          />
        </Card>
      </QueryState>

      <KillSwitchPanel />
    </div>
  );
}
