import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { messageKeyOf } from "../api/errors.ts";
import { useApi, useAuth } from "../auth/AuthProvider.tsx";
import { hasAnyRole } from "../auth/types.ts";
import { useT } from "../i18n/I18nProvider.tsx";
import { Badge, Button, Section, Table, useToast } from "../ui/index.ts";
import type { BadgeTone, Column } from "../ui/index.ts";
import type {
  ConfigFinding,
  ConfigHealthResponse,
  ConfigSeverity,
  HealthResponse,
  ServiceHealth,
  ServiceState,
  SettingsView,
} from "./common/index.ts";
import { QueryState } from "./common/index.ts";
import { useLabel, usePhrase } from "./common/label.ts";
import {
  InfrastructureSection,
  SETTINGS_ID_FOR_SERVICE,
  SETTINGS_QUERY_KEY,
} from "./health/InfrastructureSection.tsx";
import { KillSwitchSection } from "./health/KillSwitchSection.tsx";
import { ageLabel } from "./shared/format.ts";

const STATE_TONE: Readonly<Record<ServiceState, BadgeTone>> = {
  healthy: "green",
  degraded: "amber",
  down: "red",
  // Grey on purpose: "nobody set this up" is a to-do, not an alarm.
  not_configured: "gray",
};

/**
 * Yapılandırma satırlarının rozet rengi. `bilgi` GRİ: "kapalı ağda webhook
 * yok" bir alarm değil bir gerçektir, ve onu kehribara boyamak operatöre
 * kehribarı yok saymayı öğretir.
 */
const CONFIG_TONE: Readonly<Record<ConfigSeverity, BadgeTone>> = {
  sorun: "red",
  uyari: "amber",
  bilgi: "gray",
  iyi: "green",
};

/**
 * Tanı raporunu kim indirebilir. Tablo admin + tech-lead'e açık; raporun
 * kendisi admin'e — tek dosyada toplanmış hâlin ağırlığı parçaların
 * toplamından fazla. Sunucudaki kapı asıl kapıdır (`studio-ops.ts`).
 */
const TANI_ROLES = ["admin"] as const;

/** `maestro-tani-YYYYAAGG-SSDD.html` — sunucunun `content-disposition` biçiminin aynısı. */
function taniFileName(now: Date): string {
  const iki = (sayi: number): string => String(sayi).padStart(2, "0");
  const gun = `${String(now.getFullYear())}${iki(now.getMonth() + 1)}${iki(now.getDate())}`;
  return `maestro-tani-${gun}-${iki(now.getHours())}${iki(now.getMinutes())}.html`;
}

/**
 * Rows the operator can fix from Bağlantılar — the managed connections. Their
 * `version` is the KIND that answered (`jira_cloud`, `openai_compat`), not a
 * version string, and is rendered as the kind's name.
 */
const CONNECTION_SERVICES: ReadonlySet<string> = new Set(["llm", "jira", "scm"]);

/**
 * Sistem sağlığı — four sections, top to bottom in the order an operator
 * needs them during an incident:
 *
 *  1. Acil durdurma — the kill switch, one line, operated from here only.
 *  2. Yapılandırma — HOW this install is set up (driver, listening, models),
 *     with the downloadable diagnosis report. No findings is a clean install,
 *     not a failed read — the table says so and the download button stays.
 *  3. Servisler — liveness from `/studio/health`, with the engine's and the
 *     database's addresses joined in from `/settings`.
 *  4. Altyapı — the remaining `deploy/.env` wiring (identity, SIEM, proxy…)
 *     and the notify channels. Rows the services table already probes are
 *     not repeated.
 *
 * Every section has its own query and its own `QueryState`: a failing
 * diagnosis must never take the liveness table down with it.
 */
export function HealthScreen(): ReactNode {
  const api = useApi();
  const t = useT();
  const label = useLabel();
  const phrase = usePhrase();
  const toast = useToast();
  const { session } = useAuth();
  const [downloading, setDownloading] = useState(false);

  /**
   * Tanı raporunu indir — sunucuya SSH'lemeden. `getBlob` üzerinden: oturum
   * jetonu tarayıcının kendiliğinden eklemeyeceği bir başlıkta taşınıyor.
   */
  const downloadTani = async (): Promise<void> => {
    setDownloading(true);
    try {
      const blob = await api.getBlob("/studio/tani");
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = taniFileName(new Date());
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast.show("error", t(messageKeyOf(error)));
    } finally {
      setDownloading(false);
    }
  };

  const health = useQuery({
    queryKey: ["studio-health"],
    queryFn: ({ signal }) => api.get<HealthResponse>("/studio/health", { signal }),
    refetchInterval: 60_000,
  });

  /** Yapılandırma teşhisi: ayrı sorgu, seyrek (5 dk) — bir ayar değişmedikçe cevabı değişmez. */
  const config = useQuery({
    queryKey: ["studio-config-health"],
    queryFn: ({ signal }) => api.get<ConfigHealthResponse>("/studio/config-health", { signal }),
    refetchInterval: 300_000,
  });

  /** The same fetch the infrastructure section makes — deduplicated by key. */
  const settings = useQuery({
    queryKey: SETTINGS_QUERY_KEY,
    queryFn: ({ signal }) => api.get<SettingsView>("/settings", { signal }),
  });

  const findings = config.data?.findings ?? [];
  const services = health.data?.services ?? [];
  const endpointOf = (service: string): string | null => {
    const id = SETTINGS_ID_FOR_SERVICE[service];
    if (id === undefined) return null;
    const row = settings.data?.connections.find((candidate) => candidate.id === id);
    return row === undefined || row.endpoint === "" ? null : row.endpoint;
  };

  const columns: readonly Column<ServiceHealth>[] = [
    {
      key: "service",
      header: t("health.col.service"),
      // The id is the fallback: an uncatalogued component must still appear.
      cell: (row) => <b>{label(`health.service.${row.service}`, row.service)}</b>,
    },
    {
      key: "state",
      header: t("health.col.status"),
      cell: (row) => (
        <Badge tone={STATE_TONE[row.state]} icon="●">
          {label(`health.state.${row.state}`, row.state)}
        </Badge>
      ),
    },
    {
      key: "version",
      header: t("health.col.version"),
      cell: (row) => {
        const endpoint = endpointOf(row.service);
        return (
          <span className="scr-mono scr-mini">
            {CONNECTION_SERVICES.has(row.service)
              ? label(`connections.kind.${row.version}`, row.version)
              : row.version}
            {endpoint !== null && <> · {endpoint}</>}
          </span>
        );
      },
    },
    {
      key: "checked",
      header: t("health.col.checked"),
      cell: (row) => {
        const age = ageLabel(row.checkedAt);
        return <span className="scr-mini">{age === null ? "—" : t(age.key, age.params)}</span>;
      },
      align: "right",
    },
    {
      key: "note",
      header: t("health.col.note"),
      cell: (row) => (
        <span className="scr-mini">
          {row.note === null ? "—" : label(row.note, "—")}
          {/* A fault the operator cannot fix from THIS page is linked to the
              screen that fixes it — connection rows only, never over green. */}
          {CONNECTION_SERVICES.has(row.service) && row.state !== "healthy" && (
            <>
              {" · "}
              <Link to="/settings">{t("health.action.open_connections")}</Link>
            </>
          )}
        </span>
      ),
    },
  ];

  const configColumns: readonly Column<ConfigFinding>[] = [
    {
      key: "item",
      header: t("config.col.item"),
      cell: (row) => <b>{label(`config.row.${row.id}`, row.id)}</b>,
    },
    {
      key: "state",
      header: t("config.col.state"),
      cell: (row) => (
        <Badge tone={CONFIG_TONE[row.severity] ?? "gray"} icon="●">
          {label(`config.severity.${row.severity}`, row.severity)}
        </Badge>
      ),
    },
    {
      key: "value",
      header: t("config.col.value"),
      cell: (row) => <b className="scr-mono">{label(`config.value.${row.value}`, row.value)}</b>,
    },
    {
      key: "detail",
      header: t("config.col.detail"),
      // ÇÖZÜM yalnız düzeltilecek bir şey varken — yeşil bir satırın yanındaki
      // "şunu yapın" cümlesi olmayan bir arızayı varmış gibi okutur.
      cell: (row) => (
        <span className="scr-mini">
          {row.detailKey === null ? "—" : phrase(row.detailKey, row.detailParams)}
          {row.fixKey !== null && <> <b>{phrase(row.fixKey, row.fixParams)}</b></>}
        </span>
      ),
    },
  ];

  const mayDownload = hasAnyRole(session, TANI_ROLES);

  return (
    <div className="scr-stack">
      <KillSwitchSection />

      <Section
        title={t("config.card.title")}
        subtitle={t("config.card.sub")}
        actions={
          <>
            {config.data !== undefined && (
              <Badge tone={CONFIG_TONE[config.data.state] ?? "gray"} icon="●">
                {label(`config.overall.${config.data.state}`, config.data.state)}
              </Badge>
            )}
            {mayDownload && (
              // `busy`: a second click during the download would mean a second
              // full report generated on the server.
              <Button size="sm" busy={downloading} onClick={() => void downloadTani()}>
                {t("config.tani.download")}
              </Button>
            )}
          </>
        }
      >
        <QueryState
          isPending={config.isPending}
          error={config.error}
          onRetry={() => void config.refetch()}
          skeletonRows={3}
        >
          <Table
            columns={configColumns}
            rows={findings}
            rowKey={(row) => row.id}
            emptyLabel={t("config.empty")}
            caption={t("config.card.title")}
          />
        </QueryState>
        {/* The report from this button does NOT include service logs (the BFF
            cannot reach sibling containers). Half a report read as "no problem"
            is the silent failure this screen exists to close, so the gap is
            stated beside the button, not in a footnote. */}
        {mayDownload && <p className="scr-hint scr-hint--warn">{t("config.tani.partial")}</p>}
      </Section>

      <Section
        title={t("health.card.services")}
        actions={
          health.data !== undefined ? (
            <Badge tone={STATE_TONE[health.data.state]} icon="●">
              {t(`health.overall.${health.data.state}`)}
            </Badge>
          ) : undefined
        }
      >
        <QueryState
          isPending={health.isPending}
          error={health.error}
          onRetry={() => void health.refetch()}
          skeletonRows={4}
        >
          <Table
            columns={columns}
            rows={services}
            rowKey={(row) => row.service}
            emptyLabel={t("health.empty.services")}
            caption={t("health.card.services")}
          />
        </QueryState>
      </Section>

      <InfrastructureSection coveredServices={new Set(services.map((row) => row.service))} />
    </div>
  );
}
