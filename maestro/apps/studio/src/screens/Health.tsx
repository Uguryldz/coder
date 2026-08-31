import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { messageKeyOf } from "../api/errors.ts";
import { useApi, useAuth } from "../auth/AuthProvider.tsx";
import { hasAnyRole } from "../auth/types.ts";
import { useT } from "../i18n/I18nProvider.tsx";
import { Badge, Button, Card, Table, useToast } from "../ui/index.ts";
import type { BadgeTone, Column } from "../ui/index.ts";
import type {
  ConfigFinding,
  ConfigHealthResponse,
  ConfigSeverity,
  HealthResponse,
  ServiceHealth,
  ServiceState,
} from "./common/index.ts";
import { QueryState } from "./common/index.ts";
import { useLabel, usePhrase } from "./common/label.ts";
import { ageLabel } from "./shared/format.ts";
import "./common/screens.css";

const STATE_TONE: Readonly<Record<ServiceState, BadgeTone>> = {
  healthy: "green",
  degraded: "amber",
  down: "red",
  // Grey on purpose: "nobody set this up" is a to-do, not an alarm, and an
  // amber badge here would train operators to ignore amber.
  not_configured: "gray",
};

/**
 * Yapılandırma satırlarının rozet rengi.
 *
 * `bilgi` GRİ, ve bu servis tablosundaki `not_configured`ın gri olmasıyla aynı
 * gerekçe: "kapalı ağda webhook yok" bir alarm değil bir gerçektir, ve onu
 * kehribara boyamak operatöre kehribarı yok saymayı öğretir — gerçek bir bulgu
 * kaçtığında bedelini ödeyen tam olarak bu alışkanlıktır.
 */
const CONFIG_TONE: Readonly<Record<ConfigSeverity, BadgeTone>> = {
  sorun: "red",
  uyari: "amber",
  bilgi: "gray",
  iyi: "green",
};

/**
 * Tanı raporunu kim indirebilir. Ekrandaki TABLO `OPS_ROLES` ile açık
 * (admin + tech-lead), ama raporun kendisi admin'e: tek dosyada toplanmış
 * hâlin ağırlığı parçaların toplamından fazla. Sunucudaki kapı asıl kapıdır
 * (`studio-ops.ts`); buradaki, olmayan bir düğmeyi göstermemek için.
 */
const TANI_ROLES = ["admin"] as const;

/**
 * `maestro-tani-YYYYAAGG-SSDD.html` — sunucunun `content-disposition` ile
 * söylediği biçimin aynısı. `blob:` bağlantısında tarayıcı o başlığı okumuyor,
 * bu yüzden burada da yazılı; ikisi ayrışırsa yalnız ad değişir.
 */
function taniFileName(now: Date): string {
  const iki = (sayi: number): string => String(sayi).padStart(2, "0");
  const gun = `${String(now.getFullYear())}${iki(now.getMonth() + 1)}${iki(now.getDate())}`;
  return `maestro-tani-${gun}-${iki(now.getHours())}${iki(now.getMinutes())}.html`;
}

/**
 * Rows the operator can fix from the settings screen — the managed
 * connections (LLM / Jira / SCM). Anything else on this table is
 * infrastructure the settings screen cannot repair, so pointing there would
 * be a false trail.
 */
const CONNECTION_SERVICES: ReadonlySet<string> = new Set(["llm", "jira", "scm"]);

/**
 * Platform dependency health (M6) — the detail behind the unauthenticated
 * `/readyz` probe.
 *
 * The overall state comes from the BFF rather than being derived here: it
 * decides that `down` beats `degraded` beats `healthy`, and a client that
 * recomputed the same rule would eventually disagree with the alert that pages
 * somebody.
 *
 * The backup and restore-drill panel the mock draws is NOT rendered as data.
 * `/studio/health` reports service liveness only, and a "restore drill: never
 * run" line invented client-side would be the most dangerous kind of wrong: it
 * would look like a finding the platform is tracking (M66) when nothing is.
 *
 * ── YAPILANDIRMA BÖLÜMÜ ─────────────────────────────────────────────────────
 * Servis tablosunun ÜSTÜNDE ikinci bir bölüm: bu kurulum NASIL kurulmuş.
 * Operatörün sorusu buydu — "DC ise DC göreyim orada" — ve o cevap hiçbir
 * ekranda yoktu: sürücü kimliği yalnız boot log'unda yazıyordu, yani sunucuda
 * kabuğu olmayan bir banka operatörü için hiçbir yerde.
 *
 * Neden ÜSTTE: canlılık tablosu bir kesinti anında okunur, yapılandırma tablosu
 * ise kurulumdan sonra ve "neden hiçbir şey olmuyor?" anında — ki bu ikincisi
 * bu üründe çok daha sık ve çok daha sessiz bir arıza sınıfı. Sıralama da
 * sunucudan geliyor (`sorun` en üstte), burada yeniden hesaplanmıyor: iki yerde
 * iki sıralama kuralı, ekranın kırmızıyı gömdüğü günü davet ederdi.
 *
 * Bu bölümün başarısızlığı servis tablosunu DÜŞÜRMEZ: iki ayrı sorgu, iki ayrı
 * `QueryState`. Bir teşhis eklentisinin, teşhis etmeye geldiği ekranı
 * karartması olacak en kötü şeydir.
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
   * Tanı raporunu indir — sunucuya SSH'lemeden, docker'a girmeden.
   *
   * `getBlob` üzerinden, düz bir `<a href>` ile değil: oturum jetonu tarayıcının
   * kendiliğinden eklemeyeceği bir başlıkta taşınıyor. Denetim CSV'sinin
   * (`Audit.tsx`) izlediği yolun aynısı.
   *
   * Dosya adını SUNUCU söylüyor (`content-disposition`), ama tarayıcı bir
   * `blob:` bağlantısında onu okumuyor — bu yüzden `download` niteliğine burada
   * da aynı biçim yazılıyor. İkisi ayrışırsa dosyanın adı değişir, içeriği
   * değil; yine de aynı biçimde tutuluyor ki operatör iki yoldan inen raporu
   * yan yana koyabilsin.
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

  /**
   * Yapılandırma teşhisi. Ayrı bir sorgu ve ÇOK daha seyrek yenileniyor
   * (5 dk): bu satırların cevabı bir ayar değişmedikçe değişmez, ve varyant
   * denetimi ile kural okuması veritabanına gidiyor — 60 saniyede bir
   * tekrarlamak, hiç değişmeyen bir cevap için ödenen bir bedel olurdu.
   */
  const config = useQuery({
    queryKey: ["studio-config-health"],
    queryFn: ({ signal }) => api.get<ConfigHealthResponse>("/studio/config-health", { signal }),
    refetchInterval: 300_000,
  });

  const findings = config.data?.findings ?? [];

  const services = health.data?.services ?? [];

  const columns: readonly Column<ServiceHealth>[] = [
    {
      key: "service",
      header: t("health.col.service"),
      // The id is the fallback: a component the catalog has not learned yet
      // must still appear, and it is the one worth noticing.
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
      cell: (row) => <span className="scr-mono scr-mini">{row.version}</span>,
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
          {/* The wizard's pattern (Setup.tsx): a fault the operator cannot fix
              from THIS page is named and linked to the screen that fixes it.
              Only for connection-backed rows, and never over a green one. */}
          {CONNECTION_SERVICES.has(row.service) && row.state !== "healthy" && (
            <>
              {" · "}
              <Link to="/settings">{t("setup.prereq.open_settings")}</Link>
            </>
          )}
        </span>
      ),
    },
  ];

  /**
   * Yapılandırma tablosunun kolonları.
   *
   * Servis tablosunun deseninin aynısı — ad / rozet / açıklama — bilerek: bu
   * ekranı bilen operatör ikinci tabloyu öğrenmek zorunda kalmasın. Yeni bir
   * tasarım dili getirmiyoruz.
   */
  const configColumns: readonly Column<ConfigFinding>[] = [
    {
      key: "item",
      header: t("config.col.item"),
      // Katalogda olmayan bir satır kimliği ham hâliyle görünür: sunucu bu
      // ekranın bilmediği bir bulgu eklediyse, görülmesi gereken tam odur.
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
      // Değer kapalı bir kümeden geliyor ve `config.value.*` ile çevriliyor;
      // çevrilemeyen bir değer ham hâliyle, tek aralıklı yazıyla görünür.
      cell: (row) => (
        <b className="scr-mono">{label(`config.value.${row.value}`, row.value)}</b>
      ),
    },
    {
      key: "detail",
      header: t("config.col.detail"),
      cell: (row) => (
        <span className="scr-mini">
          {row.detailKey === null ? "—" : phrase(row.detailKey, row.detailParams)}
          {/* ÇÖZÜM yalnız düzeltilecek bir şey varken. Yeşil bir satırın
              yanındaki "şunu yapın" cümlesi, olmayan bir arızayı varmış gibi
              okutur — servis tablosundaki bağlantı linkinin kuralı ile aynı. */}
          {row.fixKey !== null && (
            <>
              {" "}
              <b>{phrase(row.fixKey, row.fixParams)}</b>
            </>
          )}
        </span>
      ),
    },
  ];

  return (
    <div className="scr-stack">
      {/* Servis canlılığının ÜSTÜNDE ve KENDİ QueryState'i ile: bu bölümün
          hatası aşağıdaki tabloyu düşürmez. */}
      <QueryState
        isPending={config.isPending}
        error={config.error}
        isEmpty={findings.length === 0}
        emptyTitle={t("config.empty")}
        emptyIcon="🧭"
        onRetry={() => void config.refetch()}
      >
        {config.data !== undefined && (
          <div className="scr-row">
            <Badge tone={CONFIG_TONE[config.data.state] ?? "gray"} icon="●">
              {label(`config.overall.${config.data.state}`, config.data.state)}
            </Badge>
          </div>
        )}

        <Card
          title={t("config.card.title")}
          subtitle={t("config.card.sub")}
          padded={false}
          /* İndirme yalnız admin'e: rapor akış durumunu, ticket anahtarlarını
             ve yapılandırmayı TEK dosyada topluyor, ve o dosya tasarımı gereği
             dolaşıyor. Sunucu da aynı kapıyı tutuyor — buradaki gizleme bir
             kolaylık, yetki kararı değil (uydurma bir 403 yerine düğmeyi hiç
             göstermemek). */
          actions={
            hasAnyRole(session, TANI_ROLES) ? (
              /* Denetim CSV'sinin düğmesiyle aynı: varsayılan biçim ve
                 `busy` — indirme sırasında ikinci bir tıklama, sunucuda
                 ikinci bir tam rapor üretimi demek. */
              <Button busy={downloading} onClick={() => void downloadTani()}>
                {t("config.tani.download")}
              </Button>
            ) : undefined
          }
        >
          <Table
            columns={configColumns}
            rows={findings}
            rowKey={(row) => row.id}
            emptyLabel={t("config.empty")}
            caption={t("config.card.title")}
          />
          {/* EKSİĞİ SÖYLEYEN SATIR, ve bu tablonun en önemli cümlesi.
              Panelden inen rapor servis log'larını İÇERMEZ (BFF bir
              konteynerin içinde, docker soketi bilerek bağlı değil). Yarım bir
              rapora bakıp "sorun yok" demek, bu ekranın kapatmaya geldiği
              sessiz-yanlışın ta kendisi olurdu — o yüzden eksiklik butonun
              YANINDA yazıyor, raporun içinde tekrar ediliyor, ve hiçbirinde
              küçük punto bir dipnot değil. */}
          {hasAnyRole(session, TANI_ROLES) && (
            <p className="scr-note scr-note--warn">{t("config.tani.partial")}</p>
          )}
        </Card>
      </QueryState>

      <QueryState
        isPending={health.isPending}
        error={health.error}
        isEmpty={services.length === 0}
        emptyTitle={t("health.empty.services")}
        emptyIcon="💚"
        onRetry={() => void health.refetch()}
      >
        {health.data !== undefined && (
          <div className="scr-row">
            <Badge tone={STATE_TONE[health.data.state]} icon="●">
              {t(`health.overall.${health.data.state}`)}
            </Badge>
          </div>
        )}

        <Card title={t("health.card.services")} padded={false}>
          <Table
            columns={columns}
            rows={services}
            rowKey={(row) => row.service}
            emptyLabel={t("health.empty.services")}
            caption={t("health.card.services")}
          />
        </Card>
      </QueryState>
    </div>
  );
}
