import { useState } from "react";
import type { ReactNode } from "react";
import { useT } from "../../i18n/I18nProvider.tsx";
import { Badge, Button, Table } from "../../ui/index.ts";
import type { Column } from "../../ui/index.ts";
import { PROBE_REASONS, type ProbeResult, type ProbeTicket } from "./types.ts";

/**
 * DENEME SONUCU — kuralın ürettiği JQL, eşleşenler, ve eşleşme yoksa
 * karşılaştırma listesi.
 *
 * Asıl iş ikinci tablo. "0 sonuç" yarım cevaptır: dört farklı sebep (tip adı
 * farklı, statü tutmuyor, ticket bota atanmamış, etiket yok) aynı "0" gibi
 * görünür. Projedeki AÇIK ticket'ları aynı sütunlarla yan yana koymak dördünü
 * tek bakışta ayırt ettirir.
 */
export function RuleProbe({
  result,
  stale,
  onRetest,
  busy,
}: {
  readonly result: ProbeResult;
  /** Formdaki değerler test edilenden farklı — tablo artık başka bir kuralı anlatıyor. */
  readonly stale: boolean;
  readonly onRetest: () => void;
  readonly busy: boolean;
}): ReactNode {
  const t = useT();
  if (!result.ok) {
    // Adlandırılmış sebep katalogdan; `unbound_project` ile `no_bot_account`
    // operatörü iki AYRI ekrana gönderir, tek cümle yarısını yanlış yollardı.
    return (
      <div className="scr-note scr-note--warn" style={{ marginTop: 12 }}>
        <b>{t("listening.probe.failed")}</b>{" "}
        {PROBE_REASONS.includes(result.reason)
          ? t(`listening.probe.reason.${result.reason}`)
          : t("listening.probe.reason.unknown")}
        {result.detail !== undefined && result.detail !== "" && (
          <pre className="scr-code" style={{ marginTop: 6, whiteSpace: "pre-wrap" }}>
            {result.detail}
          </pre>
        )}
      </div>
    );
  }

  const empty = result.matched.length === 0;
  return (
    <div style={{ marginTop: 12 }}>
      {stale && (
        <div className="scr-note scr-note--warn scr-row" style={{ marginBottom: 10 }}>
          <b>{t("listening.probe.stale")}</b>
          <Button size="sm" busy={busy} onClick={onRetest}>
            {t("listening.probe.retest")}
          </Button>
        </div>
      )}

      <div className="scr-hint">{t("listening.probe.jql_label")}</div>
      <JqlBox jql={result.jql} />

      {empty ? (
        <>
          {/* Sıfır sonuç bir YASAK değil: bugün eşleşen olmayabilir, yarın olur. */}
          <div className="scr-note scr-note--warn" style={{ marginTop: 10 }}>
            <b>{t("listening.probe.no_match")}</b> {t("listening.probe.no_match_hint")}
          </div>
          {result.projectSample.length > 0 && (
            <>
              <div className="scr-hint" style={{ marginTop: 10 }}>
                {t("listening.probe.compare", { count: String(result.projectSample.length) })}
              </div>
              <ProbeTable rows={result.projectSample} />
            </>
          )}
          {result.projectSample.length === 0 && result.sampleJql !== null && (
            <div className="scr-hint" style={{ marginTop: 10 }}>
              {t("listening.probe.project_empty")}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="scr-hint" style={{ marginTop: 10 }}>
            {t("listening.probe.matched", { count: String(result.matched.length) })}
          </div>
          <ProbeTable rows={result.matched} />
        </>
      )}
    </div>
  );
}

/**
 * Üretilen JQL, KOPYALANABİLİR halde — operatör aynı sorguyu Jira'nın arama
 * kutusunda da denesin diye. Salt-okunur textarea: panoya erişimi olmayan bir
 * tarayıcıda (HTTP üzerinden açılmış kurulum) elle seçmek hâlâ çalışır.
 */
function JqlBox({ jql }: { readonly jql: string }): ReactNode {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <div className="scr-row" style={{ alignItems: "flex-start", marginTop: 4 }}>
      <textarea
        readOnly
        className="ui-input scr-mono"
        aria-label={t("listening.probe.jql_label")}
        value={jql}
        rows={2}
        style={{ flex: 1, resize: "vertical" }}
        onFocus={(e) => e.currentTarget.select()}
      />
      <Button
        size="sm"
        onClick={() => {
          void navigator.clipboard
            ?.writeText(jql)
            .then(() => setCopied(true))
            .catch(() => setCopied(false));
        }}
      >
        {copied ? t("listening.probe.copied") : t("listening.probe.copy")}
      </Button>
    </div>
  );
}

/** Bir ticket listesi — kuralın karşılaştırdığı DÖRT alan, ticket metni yok. */
function ProbeTable({ rows }: { readonly rows: readonly ProbeTicket[] }): ReactNode {
  const t = useT();
  const columns: readonly Column<ProbeTicket>[] = [
    {
      key: "key",
      header: t("listening.probe.col.key"),
      cell: (r) => (
        <>
          <b className="scr-mono">{r.key}</b>
          {/* "Bu zaten alınmış." Koşusu olan eşleşme taramanın hatası değil işidir. */}
          {r.alreadyKnown && (
            <>
              {" "}
              <Badge tone="gray">{t("listening.probe.already_known")}</Badge>
            </>
          )}
        </>
      ),
    },
    {
      key: "issueType",
      header: t("listening.probe.col.type"),
      cell: (r) => <span className="scr-mono">{r.issueType ?? "—"}</span>,
    },
    {
      key: "status",
      header: t("listening.probe.col.status"),
      cell: (r) => <span className="scr-mono">{r.status ?? "—"}</span>,
    },
    {
      key: "assignee",
      header: t("listening.probe.col.assignee"),
      // Atanmamış ticket, 0 dönmenin en sık sebebi — boş hücre bunu söylemez.
      cell: (r) => <span>{r.assignee ?? t("listening.probe.unassigned")}</span>,
    },
    {
      key: "labels",
      header: t("listening.probe.col.labels"),
      cell: (r) => (
        <span className="scr-mono">{r.labels.length === 0 ? "—" : r.labels.join(", ")}</span>
      ),
    },
  ];
  return (
    <Table
      columns={columns}
      rows={rows}
      rowKey={(r) => r.key}
      emptyLabel={t("listening.probe.no_match")}
    />
  );
}
