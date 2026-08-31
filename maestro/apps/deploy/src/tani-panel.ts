import { maskEndpointCredentials } from "@maestro/bff";
import type {
  ConfigFinding,
  ConfigHealthInput,
  TaniReport,
} from "@maestro/bff";
import { buildConfigFindings } from "@maestro/bff";
import { t } from "@maestro/config";
import {
  maskeleSatir,
  taniHtml,
  type AkisBolumu,
  type Bulgu,
  type BulguSeviye,
  type JiraBolumu,
  type KosuSatiri,
  type ServisLogu,
  type TaniRaporu,
} from "./tani.js";

/**
 * PANELDEN indirilen tanı raporu — `./tani.sh`in UI'dan erişilebilen hâli.
 *
 * ── NEDEN VAR ───────────────────────────────────────────────────────────────
 * Operatörün cümlesi: "bu scripti uidan göremezmiyim, docker içine girmeden".
 * `./tani.sh` bir kabuk, bir SSH anahtarı ve docker yetkisi istiyor; bankada
 * üçü de bir talep formudur. Erişilemeyen bir teşhis aracı, var olmayan bir
 * teşhis aracıdır — ve bu turda kapatılan hataların hepsi tam olarak "hiçbir
 * yerde görünmüyordu" sınıfındandı.
 *
 * ── BU RAPOR BETİĞİN ALT KÜMESİDİR, VE BUNU KENDİSİ SÖYLER ──────────────────
 * Bir eksik var ve kapatılamaz: SERVİS LOG'LARI. Betik onları HOST'tan alıyor
 * (`docker compose logs`); BFF bir konteynerin İÇİNDE çalışıyor ve kardeş
 * konteynerlerin log'una erişemez. Docker soketini konteynere bağlamak bunu
 * çözerdi ve KESİNLİKLE yapılmamalı: panele erişebilen bir saldırgan, o soket
 * üzerinden host'un tamamına root olur. Yani eksiklik bir kusur değil, bilinçli
 * bir güvenlik kararının sonucudur.
 *
 * BFF'in KENDİ log'u da alınamıyor, ve sebebi ayrı: `server.ts:138` Fastify'ı
 * yalnız bir seviye ile kuruyor, yani pino doğrudan stdout'a yazıyor — dosya
 * yok, tablo yok, halka tampon yok. Süreç içinden geriye okunacak bir yer YOK.
 * Bir halka tampon eklemek mümkün ama küçük bir iş değil: her satırın sır
 * denetiminden geçmesi, bellek sınırının konması ve yeni bir sızıntı yüzeyinin
 * gözden geçirilmesi gerekir. Bu turun işi değil; eksikliğin RAPORUN İÇİNDE
 * adıyla yazılması ise şart.
 *
 * Bu yüzden `logBolumu` boş bir bölüm DEĞİL, gerekçesi yazılı bir bölüm
 * üretiyor. `taniHtml` `ServisLogu.hata` alanını "log alınamadı" başlığıyla
 * gösteriyor — yani eksiklik sayfanın 4. bölümünde, betiğin tam raporunda
 * log'ların olduğu yerin TAM OLARAK kendisinde okunuyor. Boş bir bölüm
 * "log'larda sorun yok" diye okunurdu, ve yarım rapora bakıp "sorun yok" demek
 * bu aracın kapatmaya geldiği hatanın ta kendisidir.
 *
 * ── NEDEN BULGULARI YENİDEN HESAPLAMIYOR ────────────────────────────────────
 * 1. bölümün satırları `buildConfigFindings`ten geliyor — panelin "Yapılandırma"
 * tablosunu besleyen fonksiyonun AYNISI. İkinci bir teşhis mantığı yazmak,
 * ekranın "iyi" derken raporun "kritik" dediği günü davet ederdi; ve o gün
 * hangisine inanılacağını kimse bilemezdi.
 */

/** Ekranın ağırlıkları → raporun seviyeleri. */
const SEVIYE: Readonly<Record<ConfigFinding["severity"], BulguSeviye>> = {
  sorun: "kritik",
  uyari: "uyari",
  // Rapor tarafında "bilgi" diye bir seviye yok, ve olmamalı: `ozetle` yalnız
  // dört kovaya bakıyor. `bilgi` → `uyari` demek DC'de webhook yokluğunu
  // uyarıya çıkarırdı; `iyi` demek onu yeşile boyardı. `bilinmiyor` ikisinden
  // de dürüst: "bu bir gerçektir, alarm değildir, ve doğrulanmış da değildir".
  bilgi: "bilinmiyor",
  iyi: "iyi",
};

/** Akış bölümünü besleyen, veritabanının tanı için gereken kadarı. */
export interface AkisKaynagi {
  /** Toplam koşu sayısı. */
  readonly toplam: () => Promise<number>;
  /** Adım → koşu sayısı. */
  readonly adimDagilimi: () => Promise<readonly (readonly [string, number])[]>;
  /** 2b'de bekleyen koşular — netleştirme cevabı beklenenler. */
  readonly netlestirmeBekleyen: () => Promise<readonly KosuSatiri[]>;
  readonly sonKosular: () => Promise<readonly KosuSatiri[]>;
  /** Temporal'daki açık workflow sayısı. Fırlatabilir; sebebi rapora yazılır. */
  readonly temporalAcik: () => Promise<number>;
  /**
   * Veritabanına göre BEKLEYEN (terminal olmayan) koşular — kayıp koşu
   * kıyasının sol tarafı. Bkz. `AkisBolumu.kayipKosular`.
   */
  readonly bekleyenKosular: () => Promise<readonly KosuSatiri[]>;
  /**
   * Temporal'da AÇIK execution'ı olan ticket anahtarları — kıyasın sağ tarafı.
   *
   * Sayı değil KÜME, çünkü soru "kaç tane" değil "HANGİLERİ": operatörün
   * ihtiyacı olan şey kayıp koşuların listesidir, bir eksiltme sonucu değil.
   */
  readonly acikTicketlar: () => Promise<ReadonlySet<string>>;
  /** Namespace'in saklama süresi ("24 saat" / "90 gün"); okunamazsa `null`. */
  readonly saklamaSuresi: () => Promise<string | null>;
}

export interface PanelTaniOptions {
  /** Yapılandırma gerçekleri — panelin `/studio/config-health` ile okuduğu şeyin aynısı. */
  readonly config: () => Promise<ConfigHealthInput>;
  readonly akis: AkisKaynagi;
  /** Sunucu adı ve imaj sürümü — konteynerin kendi ortamından. */
  readonly hostAdi: string;
  readonly imajSurumu: string;
  readonly now: () => Date;
}

/**
 * `maskeleSatir`ın bu dosyadaki tek kurulumu — betiğin kullandığı maskenin
 * AYNISI, `maskEndpointCredentials` üzerinden. İkinci bir maskeleyici yazmak,
 * ikisinden birinin eksik kalması demektir.
 */
const maskele = (satir: string): string =>
  maskeleSatir(satir, (dsn) => maskEndpointCredentials(dsn) ?? dsn);

/** `maestro-tani-YYYYAAGG-SSDD.html` — sıralanabilir, çakışmayan, okunur. */
export function taniDosyaAdi(now: Date): string {
  const iki = (sayi: number): string => String(sayi).padStart(2, "0");
  const gun = `${String(now.getFullYear())}${iki(now.getMonth() + 1)}${iki(now.getDate())}`;
  return `maestro-tani-${gun}-${iki(now.getHours())}${iki(now.getMinutes())}.html`;
}

/**
 * Yapılandırma bulgularını raporun `Bulgu` biçimine çevir.
 *
 * Cümleler katalogdan (`packages/config/locales/tr.json`) geliyor, burada
 * yazılmıyor: panelde okunan cümle ile raporda okunan cümle AYNI olmalı, yoksa
 * operatör ikisini karşılaştırdığında hangisinin güncel olduğunu bilemez.
 * Rapor her zaman Türkçe — sunucuda üretiliyor, ve destek ticket'ına eklenen
 * dosyanın dili operatörün tarayıcı tercihine göre değişmemeli.
 */
export function bulgulara(findings: readonly ConfigFinding[]): Bulgu[] {
  const cevir = (anahtar: string, params?: Readonly<Record<string, string>>): string => {
    try {
      return t("tr", anahtar, params === undefined ? {} : { ...params });
    } catch {
      // Katalogda olmayan bir anahtar raporu düşürmez: anahtarın kendisi
      // görünür, ki eksik çeviri fark edilsin. Bir tanı aracının kendi
      // eksiğinden dolayı hiç rapor üretmemesi, üretebileceği en kötü sonuç.
      return anahtar;
    }
  };
  return findings.map((finding) => {
    const deger = cevir(`config.value.${finding.value}`);
    const aciklama = finding.detailKey === null ? "" : ` ${cevir(finding.detailKey, finding.detailParams)}`;
    return {
      baslik: cevir(`config.row.${finding.id}`),
      seviye: SEVIYE[finding.severity],
      sonuc: `${deger}.${aciklama}`,
      ...(finding.fixKey === null ? {} : { cozum: cevir(finding.fixKey, finding.fixParams) }),
    };
  });
}

/**
 * Servis log'larının YOKLUĞU, gerekçesiyle.
 *
 * Boş bir dizi döndürmek en kolay yol olurdu ve en tehlikelisi: `taniHtml` o
 * durumda "Toplanan log'larda hata/uyarı kalıbı eşleşmedi" yazar — yani
 * TOPLANMIŞ log'larda sorun bulunmadığını söyler, oysa hiç log toplanmamıştır.
 * `hata` alanı doldurulunca aynı bölüm "log alınamadı" başlığıyla ve bu
 * gerekçeyle çıkıyor.
 */
export function logsuzBolum(): TaniRaporu["log"] {
  const sebep =
    "Bu rapor PANELDEN üretildi ve servis log'larını İÇERMEZ. Sebep bir arıza değil bir " +
    "sınır: BFF bir konteynerin içinde çalışıyor ve kardeş konteynerlerin (postgres, " +
    "temporal, worker, nginx) log'una erişemez — docker soketi bilerek bağlanmamıştır, " +
    "çünkü panele erişebilen bir saldırgan o soketle sunucunun tamamını ele geçirirdi. " +
    "BFF'in kendi log'u da alınamıyor: satırlar doğrudan stdout'a yazılıyor, süreç içinden " +
    "geriye okunacak bir dosya ya da tampon yok. LOG'LARI GÖRMEK İÇİN sunucuda " +
    "./tani.sh çalıştırın — o betik aynı raporu servis log'larıyla birlikte üretir. " +
    "Bu rapora bakıp 'log'larda sorun yok' SONUCU ÇIKARILAMAZ.";
  const servisler: ServisLogu[] = [
    { servis: "servis log'ları (panel raporunda yok)", satirlar: [], gizlenen: 0, hata: sebep },
  ];
  return { servisler, dikkat: [] };
}

/** Akış bölümü — her okuma ayrı ayrı fail-soft, çünkü biri diğerini düşürmemeli. */
async function akisBolumu(kaynak: AkisKaynagi): Promise<AkisBolumu> {
  const guvenli = async <T>(oku: () => Promise<T>, varsayilan: T): Promise<T> => {
    try {
      return await oku();
    } catch {
      return varsayilan;
    }
  };

  const [toplam, adimDagilimi, netlestirmeBekleyen, sonKosular, bekleyen] = await Promise.all([
    guvenli(kaynak.toplam, 0),
    guvenli(kaynak.adimDagilimi, [] as readonly (readonly [string, number])[]),
    guvenli(kaynak.netlestirmeBekleyen, [] as readonly KosuSatiri[]),
    guvenli(kaynak.sonKosular, [] as readonly KosuSatiri[]),
    guvenli(kaynak.bekleyenKosular, [] as readonly KosuSatiri[]),
  ]);

  try {
    const temporalAcik = await kaynak.temporalAcik();
    /**
     * KAYIP KOŞU KIYASI. Temporal okunabildiyse yapılır ve YALNIZ o zaman:
     * `catch` dalı `null` döner, çünkü "kayıp yok" ile "kıyas yapılamadı" iki
     * ayrı cevaptır ve ikincisini birincisi gibi göstermek, ölçülmemiş bir şeyi
     * sağlıklı ilan etmek olurdu.
     */
    const acik = await kaynak.acikTicketlar();
    const kayipKosular = bekleyen.filter((kosu) => !acik.has(kosu.ticketKey));
    const saklamaSuresi = await guvenli(kaynak.saklamaSuresi, null);
    return {
      toplam,
      adimDagilimi,
      netlestirmeBekleyen,
      sonKosular,
      temporalAcik,
      kayipKosular,
      ...(saklamaSuresi === null ? {} : { saklamaSuresi }),
    };
  } catch (error) {
    // Temporal'ın okunamaması sayfayı düşürmez ve SESSİZ de kalmaz: sebebi
    // maskeden geçirilip yazılır (bir bağlantı hatası metninde DSN geçebilir).
    return {
      toplam,
      adimDagilimi,
      netlestirmeBekleyen,
      sonKosular,
      temporalAcik: null,
      kayipKosular: null,
      temporalHata: maskele(error instanceof Error ? error.message : String(error)),
    };
  }
}

/**
 * Canlı Jira bölümü — panel raporunda ATLANIR, ve sebebi yazılır.
 *
 * Betik bunu yapıyor çünkü bir kabuk komutu operatörün BİLEREK başlattığı tek
 * seferlik bir eylemdir. Panel butonu öyle değil: bir tarayıcı sekmesinde
 * durur, yenilenir, iki kez tıklanır. Bir teşhis butonunun her tıklanışta
 * bankanın Jira'sına dört çağrı yapması, aracın kendisini bir yük kaynağına
 * çevirirdi.
 *
 * Ve gerek de yok: Jira'nın erişilebilirliği zaten Ayarlar > Bağlantılar
 * ekranındaki TEST düğmesinin işi, ve sonucu servis canlılığı tablosunda
 * `jira` satırı olarak duruyor. Aynı soruyu ikinci bir yerden sormak, iki
 * cevabın ayrışabileceği bir yer daha açardı.
 */
function jiraBolumu(): JiraBolumu {
  return {
    atlandiSebep:
      "Canlı Jira testi panel raporunda ATLANIR. Jira'nın erişilebilirliğini panelde " +
      "Ayarlar > Bağlantılar ekranındaki TEST düğmesi ölçüyor ve sonucu Sistem Sağlığı " +
      "ekranındaki 'jira' satırında görünüyor. Dört okuma çağrısının tamamını görmek için " +
      "sunucuda ./tani.sh çalıştırın.",
    denemeler: [],
  };
}

/**
 * Panel raporunu üret. `taniHtml` ÇAĞRILIR, kopyalanmaz — sayfa düzeni, sır
 * maskesi ve HTML kaçışı tek yerde (`tani.ts`) kalır.
 */
export async function panelTaniRaporu(options: PanelTaniOptions): Promise<TaniReport> {
  const now = options.now();
  const findings = buildConfigFindings(await options.config());
  const rapor: TaniRaporu = {
    kunye: {
      uretimZamani: now.toISOString().replace("T", " ").slice(0, 19),
      hostAdi: options.hostAdi,
      imajSurumu: options.imajSurumu,
      // Sıfır, çünkü hiç log kuyruğu alınmadı. Künyedeki bu sıfır, 4. bölümün
      // gerekçesiyle birlikte okunduğunda eksikliği bir kez daha söylüyor.
      satirSayisi: 0,
    },
    yapilandirma: { bulgular: bulgulara(findings) },
    akis: await akisBolumu(options.akis),
    jira: jiraBolumu(),
    log: logsuzBolum(),
  };
  return { html: taniHtml(rapor), fileName: taniDosyaAdi(now) };
}
