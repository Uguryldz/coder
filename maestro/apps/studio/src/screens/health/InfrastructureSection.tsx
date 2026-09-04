import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useApi } from "../../auth/AuthProvider.tsx";
import { useT } from "../../i18n/I18nProvider.tsx";
import { Badge, Section, Table } from "../../ui/index.ts";
import type { BadgeTone, Column } from "../../ui/index.ts";
import type { Connection, SettingsView } from "../common/index.ts";
import { QueryState, useLabel } from "../common/index.ts";

/** The query the health screen shares with this section — one fetch, two readers. */
export const SETTINGS_QUERY_KEY = ["settings", "infrastructure"] as const;

/**
 * Which `/settings` row a `/studio/health` service already covers. The two
 * endpoints share ONE probe set (`EnvSettingsReader` is handed the health
 * reader), so a row here whose probe is on the services table is the same
 * fact twice; the services table keeps it (with the address joined in) and
 * this table drops it.
 */
export const SETTINGS_ID_FOR_SERVICE: Readonly<Record<string, string>> = {
  postgres: "database",
  temporal: "temporal",
};

/**
 * The deployment's wiring as read from `deploy/.env` — the identity provider,
 * SIEM, egress proxy, Vault, storage, the notify channels — and whether each
 * is configured. Read-only by nature: these come from the file the platform
 * booted with, and a control implying otherwise would lie about where the
 * authority lives. Nothing here duplicates the liveness table above it or the
 * managed connections on Bağlantılar.
 */
export function InfrastructureSection({
  /** Services the liveness table already shows; their `/settings` twins are hidden. */
  coveredServices,
}: {
  readonly coveredServices: ReadonlySet<string>;
}): ReactNode {
  const api = useApi();
  const t = useT();
  const label = useLabel();

  const query = useQuery({
    queryKey: SETTINGS_QUERY_KEY,
    queryFn: ({ signal }) => api.get<SettingsView>("/settings", { signal }),
  });

  const covered = new Set(
    [...coveredServices].map((service) => SETTINGS_ID_FOR_SERVICE[service] ?? service),
  );
  const rows = (query.data?.connections ?? []).filter((row) => !covered.has(row.id));

  const columns: readonly Column<Connection>[] = [
    {
      key: "name",
      header: t("settings.col.connection"),
      // An id the catalog has not learned shows raw rather than blanking the
      // table — a new component is exactly what an operator must see.
      cell: (row) => <b>{label(`settings.connection.${row.id}`, row.id)}</b>,
    },
    {
      key: "status",
      header: t("settings.col.status"),
      cell: (row) => {
        const status = infraStatusOf(row.status, row.checkedAt !== null);
        return (
          <Badge tone={status.tone} icon={status.icon}>
            {t(status.key)}
          </Badge>
        );
      },
    },
    {
      key: "endpoint",
      header: t("settings.col.target"),
      // Rendered EXACTLY as the server sent it — `database` arrives already
      // masked, and masking twice would hide whether the server did its job.
      cell: (row) =>
        row.endpoint === "" ? (
          <span className="scr-mini">{t("settings.infra.endpoint_unset")}</span>
        ) : (
          <span className="scr-mono scr-mini">{row.endpoint}</span>
        ),
    },
    {
      key: "credential",
      header: t("settings.col.credential"),
      // A POINTER into the secret store, never the secret.
      cell: (row) => <span className="scr-mono scr-mini">{row.credentialRef}</span>,
    },
  ];

  return (
    <Section title={t("settings.infra.title")} subtitle={t("settings.infra.sub")}>
      <QueryState
        isPending={query.isPending}
        error={query.error}
        onRetry={() => void query.refetch()}
        skeletonRows={4}
      >
        <Table
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          emptyLabel={t("settings.empty.connections")}
          caption={t("settings.infra.title")}
        />
        {query.data !== undefined && query.data.notifyDrivers.length > 0 && (
          <div className="scr-row" style={{ marginTop: 8 }}>
            <span className="scr-mini">{t("settings.notify.title")}</span>
            {query.data.notifyDrivers.map((driver) => (
              <Badge key={driver.channel} tone={driver.enabled ? "green" : "gray"} icon={driver.enabled ? "●" : "○"}>
                {label(`settings.channel.${driver.channel}`, driver.channel)}
              </Badge>
            ))}
          </div>
        )}
      </QueryState>
    </Section>
  );
}

/**
 * Tone/label for a deployment row, split by whether a probe ran.
 *
 * `connected` arrives in two materially different situations: a probe REACHED
 * the target (`checkedAt` set), or an address is merely configured and nobody
 * knocked. A green light over an unprobed engine is the most expensive thing
 * this table could say, so the unprobed case reads "configured" in blue.
 * `unconfigured` is grey, never red: "nobody set this up" and "this is broken"
 * send an operator to two different places.
 */
export function infraStatusOf(
  status: Connection["status"],
  probed: boolean,
): { tone: BadgeTone; icon: string; key: string } {
  if (status === "unconfigured") return { tone: "gray", icon: "○", key: "settings.status.unconfigured" };
  if (status === "degraded") return { tone: "red", icon: "✕", key: "settings.status.degraded" };
  return probed
    ? { tone: "green", icon: "●", key: "settings.status.connected" }
    : { tone: "blue", icon: "◍", key: "settings.status.configured" };
}
