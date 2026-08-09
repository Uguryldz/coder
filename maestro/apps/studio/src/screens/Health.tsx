import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useApi } from "../auth/AuthProvider.tsx";
import { useT } from "../i18n/I18nProvider.tsx";
import { Badge, Card, Table } from "../ui/index.ts";
import type { BadgeTone, Column } from "../ui/index.ts";
import {
  type HealthView,
  KeyValue,
  QueryState,
  type ServiceHealth,
  type ServiceStatus,
} from "./common/index.ts";
import { useLabel } from "./common/label.ts";

const STATUS_TONE: Readonly<Record<ServiceStatus, BadgeTone>> = {
  ok: "green",
  degraded: "amber",
  down: "red",
};

/**
 * Platform health: services, workflow engine, backups and the audit pipeline.
 *
 * The backup card exists to keep one uncomfortable fact on screen: whether a
 * RESTORE has ever been rehearsed (M66). A green "backup succeeded" line proves
 * a file was written, not that it can be read back, and a restore drill that
 * has never run is a finding waiting to happen — so a missing drill date
 * renders as a warning rather than a dash.
 */
export function HealthScreen(): ReactNode {
  const api = useApi();
  const t = useT();

  const label = useLabel();

  const health = useQuery({
    queryKey: ["health"],
    queryFn: ({ signal }) => api.get<HealthView>("/health", { signal }),
    refetchInterval: 60_000,
  });

  const columns: readonly Column<ServiceHealth>[] = [
    {
      key: "service",
      // The service id is the fallback: a component the catalog has not learned
      // yet must still appear in the list, and it is the one worth noticing.
      header: t("health.col.service"),
      cell: (row) => <b>{label(`health.service.${row.id}`, row.id)}</b>,
    },
    {
      key: "status",
      header: t("health.col.status"),
      cell: (row) => (
        <Badge tone={STATUS_TONE[row.status]} icon="●">
          {t(`health.status.${row.status}`)}
        </Badge>
      ),
    },
    {
      key: "version",
      header: t("health.col.version"),
      cell: (row) => <span className="scr-mono scr-mini">{row.version ?? "—"}</span>,
    },
    {
      key: "uptime",
      header: t("health.col.uptime"),
      cell: (row) => (
        <span className="scr-mini">
          {row.uptimeSeconds === null
            ? "—"
            : t("health.value.uptime_days", {
                days: String(Math.floor(row.uptimeSeconds / 86_400)),
              })}
        </span>
      ),
      align: "right",
    },
    {
      key: "note",
      header: t("health.col.note"),
      cell: (row) => (
        <span className="scr-mini">
          {row.noteKey === null ? "—" : label(row.noteKey, "—", row.noteParams ?? {})}
        </span>
      ),
    },
  ];

  const data = health.data;
  const drillMissing = data !== undefined && data.backup.restoreDrillAt === null;

  return (
    <div className="scr-stack">
      <QueryState
        isPending={health.isPending}
        error={health.error}
        onRetry={() => void health.refetch()}
      >
        <Card title={t("health.card.services")} padded={false}>
          <Table
            columns={columns}
            rows={data?.services ?? []}
            rowKey={(row) => row.id}
            emptyLabel={t("health.empty.services")}
            caption={t("health.card.services")}
          />
        </Card>

        {data !== undefined && (
          <div className="scr-grid scr-grid--3">
            <Card title={t("health.card.workflows")}>
              <KeyValue
                entries={[
                  { label: t("health.field.open"), value: String(data.workflows.open) },
                  {
                    label: t("health.field.longest"),
                    value: t("duration.days", { days: String(data.workflows.longestDays) }),
                  },
                  {
                    label: t("health.field.continue_as_new"),
                    value: String(data.workflows.continueAsNew),
                  },
                  {
                    label: t("health.field.failed_activities"),
                    value: String(data.workflows.failedActivities),
                  },
                ]}
              />
            </Card>

            <Card title={t("health.card.backup")}>
              <KeyValue
                entries={[
                  {
                    label: t("health.field.database_backup"),
                    value: data.backup.databaseAt ?? t("health.value.never"),
                  },
                  {
                    label: t("health.field.vault_snapshot"),
                    value: data.backup.vaultAt ?? t("health.value.never"),
                  },
                  {
                    label: t("health.field.restore_drill"),
                    value: drillMissing ? (
                      <Badge tone="amber">{t("health.value.drill_missing")}</Badge>
                    ) : (
                      (data.backup.restoreDrillAt ?? "—")
                    ),
                  },
                ]}
              />
              {drillMissing && (
                <div className="scr-note scr-note--warn" style={{ marginTop: 11 }}>
                  {t("health.note.restore_drill")}
                </div>
              )}
            </Card>

            <Card title={t("health.card.audit")}>
              <KeyValue
                entries={[
                  { label: t("health.field.audit_queue"), value: String(data.audit.queued) },
                  {
                    label: t("health.field.last_shipped"),
                    value: data.audit.lastShippedAt ?? t("health.value.never"),
                  },
                  {
                    label: t("health.field.last_anchor"),
                    value: data.audit.lastAnchorAt ?? t("health.value.never"),
                  },
                ]}
              />
            </Card>
          </div>
        )}
      </QueryState>
    </div>
  );
}
