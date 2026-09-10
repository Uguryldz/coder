import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { auditVariantModels, createDb, type Db } from "@maestro/db";
import { maskEndpointCredentials, resolveBotIdentity } from "@maestro/bff";
import type { TicketKey } from "@maestro/contracts";
import { bootPlatform, workWiringNote } from "../boot.js";
import { resolveCommandIntake } from "../command-intake.js";
import { canSearch } from "../jira-discovery.js";
import { canReadComments } from "../jira-poller.js";
import { intakeLabel } from "../listening-banner.js";
import { connectionSecretsFrom } from "../stores/connection-secrets.js";
import { tlsSkipFlagFrom } from "../stores/connection-tls.js";
import { PrismaConnectionStore } from "../stores/connections.js";
import { prismaSqlExecutor } from "../stores/sql.js";

/** `git --version` gibi kısa yoklamalar için — tanı raporu hiçbir şey yazmaz. */
const execFileAsync = promisify(execFile);
import { connectTemporal } from "../temporal-gateway.js";
import { insanOkunur } from "../temporal-retention.js";
import {
  logAyikla,
  maskeleSatir,
  taniHtml,
  type AkisBolumu,
  type Bulgu,
  type DikkatSatiri,
  type JiraBolumu,
  type JiraDeneme,
  type KosuSatiri,
  type ServisLogu,
  type TaniRaporu,
} from "../tani.js";
import { isEntrypoint } from "./lifecycle.js";

/**
 * Tanı paketinin TOPLAYICI yarısı — uygulama imajının İÇİNDE çalışır.
 *
 * `deploy/banka/tani.sh` (ve ikizi) iki şeyi ayrı yerlerden toplar ve burada birleştirir:
 *
 *   · SUNUCUDAN toplanabilenler (docker log'ları, konteyner durumları) — bunu
 *     yalnız host yapabilir, docker soketi konteynerin içinde yok;
 *   · YIĞININ İÇİNDEN okunabilenler (yapılandırma, veritabanı, canlı Jira) —
 *     bunu yalnız imaj yapabilir, sunucuda ne node var ne Prisma istemcisi.
 *
 * Betik birinci kümeyi JSON olarak STDIN'den verir, bu komut ikinci kümeyi
 * kendisi okur, ve TAM HTML'i stdout'a yazar. Böylece sayfayı üreten tek bir
 * kod yolu var; betik yalnızca dosyaya yönlendirir.
 *
 * ── NEDEN İMAJIN İÇİNDE ─────────────────────────────────────────────────────
 * `reset-admin.sh` ve `ajan-modelleri.sh` ile aynı desen, aynı gerekçe: banka
 * sunucusuna node/pnpm KURULMAZ. `MAESTRO_ENTRYPOINT` ile migrate servisinin
 * imajı bu dosyayı çalıştırır, Prisma istemcisi ve Jira sürücüsü imajın derli
 * `node_modules`'ından gelir.
 *
 * ── NEDEN KENDİ KONTROLLERİNİ YAZMIYOR ──────────────────────────────────────
 * Burada tek bir teşhis MANTIĞI yeniden yazılmadı. Sürücü seçimi
 * `workDriverFor`/`workWiringNote`, komut alımı `resolveCommandIntake` +
 * `intakeLabel`, bot kimliği `resolveBotIdentity`, ajan modelleri
 * `auditVariantModels`, yetenek yoklamaları `canSearch`/`canReadComments`,
 * URL maskeleme `maskEndpointCredentials`. Bu dosya onları ÇAĞIRIR ve
 * cevaplarını bir sayfaya dizer. İkinci bir kopya, gün gelip asıl koddan
 * ayrışacak ve tanı aracı yanlış teşhis koyacaktı — bir tanı aracının
 * yapabileceği en kötü şey.
 *
 * ── YAN ETKİ YOK ────────────────────────────────────────────────────────────
 * Hiçbir tabloya yazılmaz (`auditVariantModels` `apply` olmadan çağrılır),
 * hiçbir ticket'a yorum düşülmez, hiçbir statü GEÇİRİLMEZ — geçişler yalnızca
 * `GET .../transitions` ile LİSTELENİR. Bir tanı aracı, teşhis ettiği sistemi
 * değiştirmemelidir.
 */

/** Betiğin stdin'den verdiği, yalnız host'un bilebileceği gerçekler. */
interface HostGirdisi {
  readonly hostAdi?: unknown;
  readonly imajSurumu?: unknown;
  readonly uretimZamani?: unknown;
  readonly satirSayisi?: unknown;
  readonly jiraTesti?: unknown;
  /** Bilinen bir ticket anahtarı — canlı okuma denemesi için. */
  readonly ornekTicket?: unknown;
  /** servis adı → ham log satırları. */
  readonly loglar?: unknown;
}

function metin(value: unknown, varsayilan: string): string {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : varsayilan;
}

/** `unknown` bir JSON'dan servis→satırlar haritası; bozuksa boş. */
function loglariOku(value: unknown): ReadonlyMap<string, readonly string[]> {
  const out = new Map<string, readonly string[]>();
  if (typeof value !== "object" || value === null) return out;
  for (const [servis, satirlar] of Object.entries(value as Record<string, unknown>)) {
    if (typeof satirlar === "string") out.set(servis, satirlar.split("\n"));
    else if (Array.isArray(satirlar)) out.set(servis, satirlar.map((s) => String(s)));
  }
  return out;
}

async function stdinOku(): Promise<HostGirdisi> {
  // TTY'de beklemeyelim: betik hep boru ile besler, ama bu komut elle de
  // çalıştırılabilir olmalı (tek başına `docker compose run` ile) ve o durumda
  // sonsuza dek boş bir stdin'i beklemek, hiç çıktı vermemekle aynı şeydir.
  if (process.stdin.isTTY === true) return {};
  const parcalar: Buffer[] = [];
  for await (const parca of process.stdin) parcalar.push(Buffer.from(parca as Buffer));
  const ham = Buffer.concat(parcalar).toString("utf8").trim();
  if (ham === "") return {};
  try {
    const cozulen: unknown = JSON.parse(ham);
    return typeof cozulen === "object" && cozulen !== null ? (cozulen as HostGirdisi) : {};
  } catch {
    // Bozuk girdi sessizce yutulmaz ama raporu da öldürmez: log'suz bir rapor,
    // hiç rapor olmamasından iyidir ve eksikliği sayfada görünür.
    console.error("[tanı] stdin JSON okunamadı — log bölümü boş kalacak.");
    return {};
  }
}

/** Bir hatanın operatöre söylenebilir hâli. Sır taşımaz, çünkü maskeden geçer. */
function hataMetni(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** `JiraHttpError.status` — sürücü paketine tip bağımlılığı kurmadan. */
function httpKodu(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" && Number.isFinite(status) ? status : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1 · Yapılandırma
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Her kontrol için tek bir bulgu. Sıra ÖNEM sırasıdır: sürücü seçimi en üstte,
 * çünkü o yanlışsa aşağıdaki her şey yanlış yerde ölçülür.
 */
async function yapilandirmaBulgulari(options: {
  readonly env: { readonly source: Record<string, string | undefined> };
  readonly driver: string;
  readonly wiringNote: string | null;
  readonly workPort: unknown;
  readonly db: Db;
  readonly connections: PrismaConnectionStore;
  readonly beklenenMigration: number;
}): Promise<Bulgu[]> {
  const { env, driver, wiringNote, workPort, db, connections } = options;
  const bulgular: Bulgu[] = [];
  const dolu = (ad: string): boolean => (env.source[ad] ?? "").trim() !== "";

  // ── Hangi Jira sürücüsü, ve hangi değişken seçti ──────────────────────────
  // Cümlenin kendisi `workWiringNote`'un — açılış log'unda operatörün gördüğü
  // cümlenin AYNISI. İkinci bir metin yazmak, iki yerde iki farklı teşhis
  // demekti.
  if (driver === "not-configured") {
    bulgular.push({
      baslik: "Jira iş sürücüsü",
      seviye: "kritik",
      sonuc: "YAPILANDIRILMADI — ne JIRA_BASE_URL ne JIRA_CLOUD_BASE_URL dolu.",
      cozum:
        wiringNote ??
        ".env'de YALNIZCA BİRİNİ doldurup servisleri yeniden başlatın: Data Center → JIRA_BASE_URL, Cloud → JIRA_CLOUD_BASE_URL.",
    });
  } else {
    const degisken = driver === "jira-cloud" ? "JIRA_CLOUD_BASE_URL" : "JIRA_BASE_URL";
    bulgular.push({
      baslik: "Jira iş sürücüsü",
      seviye: "iyi",
      sonuc: `${driver} — çünkü ${degisken} dolu. Sürücüyü seçen başka bir değişken yoktur (WORK_DRIVER kaldırıldı).`,
      ...(wiringNote === null ? {} : { cozum: `Bu kurulum ${driver} kullanmıyorsa: ${wiringNote}` }),
    });
  }

  // ── Tarama (JIRA_DISCOVER_MS) ─────────────────────────────────────────────
  // Karar mantığı `bin/bff.ts` ile birebir aynı olmak ZORUNDA, yoksa rapor
  // "açık" derken sistem taramıyor olur. Varsayılan 5 dk ve `0` = kapalı.
  const aramaVar = canSearch(workPort);
  const taramaHam = (env.source["JIRA_DISCOVER_MS"] ?? "").trim();
  const taramaSayi = Number(taramaHam);
  const taramaYazili = taramaHam.length > 0 && Number.isFinite(taramaSayi);
  const taramaMs = taramaYazili ? taramaSayi : 300_000;
  const taramaKaynak = taramaYazili ? "JIRA_DISCOVER_MS (.env)" : "varsayılan";
  if (!aramaVar) {
    bulgular.push({
      baslik: "Ticket taraması (JQL)",
      seviye: "kritik",
      sonuc: "Bu iş sürücüsü ARAMA SUNMUYOR — tarama hiç çalışamaz.",
      cozum:
        "Arama Jira Cloud ve Jira Data Center sürücülerinde vardır. Bu kurulumda ticket'lar yalnız webhook ile ya da panelden elle girebilir. Sürücü seçimini (yukarıdaki bulgu) kontrol edin.",
    });
  } else if (taramaMs > 0) {
    bulgular.push({
      baslik: "Ticket taraması (JQL)",
      seviye: "iyi",
      sonuc: `AÇIK — her ${String(Math.round(taramaMs / 1000))} sn (kaynak: ${taramaKaynak}). Panelde jira.discover_seconds varsa canlı değer odur.`,
    });
  } else {
    bulgular.push({
      baslik: "Ticket taraması (JQL)",
      seviye: "kritik",
      sonuc: "KAPALI — .env'de JIRA_DISCOVER_MS=0 yazıyor. Bu sürücü arama sunuyor, yani kapalılık bir tercih.",
      cozum:
        "Jira webhook'u da kurulmadıysa hiçbir ticket akışa GİREMEZ: panel açık, bağlantı yeşil ve hiç koşu başlamaz. Satırı silin ya da JIRA_DISCOVER_MS=300000 (5 dk) yazın, sonra: docker compose up -d",
    });
  }

  // ── Yoklama / komut alımı ─────────────────────────────────────────────────
  // Kararı `resolveCommandIntake` verir (panel parametresi > JIRA_POLL_MS >
  // varsayılan), cümleyi `intakeLabel` kurar — ikisi de dinleme banner'ının
  // kullandığı fonksiyonlar.
  const yorumOkur = canReadComments(workPort);
  let saklananMod: unknown;
  let saklananSaniye: unknown;
  try {
    const modSatir = await db.paramVersion.findFirst({
      where: { key: "jira.command_intake" },
      orderBy: { version: "desc" },
    });
    const snSatir = await db.paramVersion.findFirst({
      where: { key: "jira.poll_seconds" },
      orderBy: { version: "desc" },
    });
    saklananMod = modSatir?.valueJson;
    saklananSaniye = snSatir?.valueJson;
  } catch {
    // Parametre tablosu okunamadı — karar yine verilir, yalnız .env'den.
  }
  const alim = resolveCommandIntake(
    { mode: saklananMod, pollSeconds: saklananSaniye },
    env.source["JIRA_POLL_MS"],
  );
  const alimKaynak =
    alim.source === "param" ? "panel ayarı" : alim.source === "env" ? "JIRA_POLL_MS (.env)" : "varsayılan";
  if (!yorumOkur) {
    bulgular.push({
      baslik: "Komut alımı (/approve, /reject)",
      seviye: "kritik",
      sonuc: "Bu sürücü YORUM OKUYAMIYOR — yoklama hiç açılamaz, onaylar yalnız webhook ile alınabilir.",
      cozum:
        "Yorum okumayı Jira Cloud ve Jira Data Center sürücüleri sunar; kurulu sürücü bunlardan biri değil. Webhook Jira'dan bu adrese ulaşamıyorsa onaylar PANELDEN verilmelidir.",
    });
  } else if (alim.mode === "webhook") {
    bulgular.push({
      baslik: "Komut alımı (/approve, /reject)",
      seviye: "uyari",
      sonuc: `${intakeLabel(alim)} (kaynak: ${alimKaynak}) — yoklama KAPALI.`,
      cozum:
        "Jira bu adrese çıkamıyorsa (kapalı ağ, kayıtsız webhook) ticket'a yazılan /approve HİÇ okunmaz ve kapı sonsuza dek bekler. Kurulum sihirbazından 'biz Jira'ya soralım' seçeneğini açın.",
    });
  } else {
    bulgular.push({
      baslik: "Komut alımı (/approve, /reject)",
      seviye: "iyi",
      sonuc: `${intakeLabel(alim)} (kaynak: ${alimKaynak}).`,
    });
  }

  // ── Bot kimliği / netleştirme dönüşü ──────────────────────────────────────
  // `resolveBotIdentity` iki kaynağı da (env + panel bağlantısı) aynı sırayla
  // okur — BFF'in yeniden giriş yolunda okuduğu sırayla. DEĞER YAZILMAZ,
  // yalnız kaynağı: bir accountId kimlik bilgisidir.
  const kimlik = await resolveBotIdentity(env.source["MAESTRO_BOT_ACCOUNT_ID"] ?? "", connections);
  if (kimlik === null) {
    bulgular.push({
      baslik: "Bot kimliği / netleştirme dönüşü",
      seviye: "kritik",
      sonuc: "Hiçbir kaynakta bot kimliği YOK — netleştirme dönüşü KAPALI.",
      cozum:
        "Maestro bir ticket'ta eksik bilgi sorduğunda, kullanıcı ticket'ı düzeltip Maestro'ya geri atasa bile koşu UYANMAZ ve hiçbir yerde hata görünmez. Açmak için: panelde Ayarlar > Bağlantılar > Jira bağlantısını TEST edin (kimlik /myself ile kendiliğinden öğrenilir), ya da .env'de MAESTRO_BOT_ACCOUNT_ID'yi doldurun (Cloud: accountId, Data Center: kullanıcı adı).",
    });
  } else {
    bulgular.push({
      baslik: "Bot kimliği / netleştirme dönüşü",
      seviye: "iyi",
      sonuc:
        kimlik.source === "env"
          ? "AÇIK — kimlik .env'deki MAESTRO_BOT_ACCOUNT_ID'den geliyor (değer yazılmadı)."
          : "AÇIK — kimlik panel bağlantı testinin öğrendiği değerden geliyor (değer yazılmadı).",
    });
  }

  // ── Ajan modelleri ────────────────────────────────────────────────────────
  // `auditVariantModels`, `ajan-modelleri.sh`'in çağırdığı denetimin ta kendisi.
  // `apply` VERİLMEZ: tanı aracı hiçbir satırı değiştirmez.
  try {
    const denetim = await auditVariantModels(db);
    if (denetim.scanned === 0) {
      bulgular.push({
        baslik: "Ajan modelleri",
        seviye: "uyari",
        sonuc: "Hiç ajan tanımı yok — migrate tohumlaması çalışmamış olabilir.",
        cozum: "docker compose logs migrate çıktısına bakın; gerekirse migrate'i yeniden çalıştırın.",
      });
    } else if (denetim.findings.length === 0) {
      bulgular.push({
        baslik: "Ajan modelleri",
        seviye: "iyi",
        sonuc: `${String(denetim.scanned)} ajan tanımı tarandı — erişilemez bulut modeline bağlı olan YOK.`,
      });
    } else {
      bulgular.push({
        baslik: "Ajan modelleri",
        seviye: "kritik",
        sonuc:
          `${String(denetim.findings.length)} ajan tanımı, internetsiz kurulumda ERİŞİLEMEYECEK bir bulut modeline bağlı: ` +
          denetim.findings.map((f) => `${f.variantId} (v${String(f.version)}) → ${f.model}`).join(", "),
        cozum:
          "Bu ajanlar çağrıldığında istek cevapsız kalır ve hata 'bağlantı kurulamadı' diye YANLIŞ YERDE görünür. Düzeltme: ./ajan-modelleri.sh --duzelt (toplu), ya da panel → Ajan tanımları → yeni sürüm yayınla (tek tek, önerilen).",
      });
    }
  } catch (error) {
    bulgular.push({
      baslik: "Ajan modelleri",
      seviye: "bilinmiyor",
      sonuc: `Denetim okunamadı: ${hataMetni(error)}`,
      cozum: "Veritabanı erişilebilir mi? docker compose logs postgres",
    });
  }

  /**
   * ── DEPO KEŞFİ: KLON KÖKÜ ve GIT ──────────────────────────────────────────
   *
   * Bu bulgu, sahada en pahalı sessizliğin karşılığı. Keşif üç şeye birden
   * bağlı ve üçü de eksikken sistem HATA VERMEZ — analizi depoyu görmeden
   * yazar, operatör de "analiz kodla ilgisiz" der. Ölçüldü: canlı kurulumda
   * `WORKSPACE_ROOT` hiç tanımlanmamıştı ve imajda `git` yoktu; bunu ortaya
   * çıkarmak bir koşuyu baştan sona izlemeyi gerektirdi.
   *
   * `git`in varlığı ÇALIŞTIRILARAK ölçülür, PATH'e bakılarak değil: imajda
   * binary olmaması ile PATH'in yanlış olması aynı sonucu doğurur ve ikisini
   * ayırmak operatörün işine yaramaz — klon ya açılabiliyordur ya değil.
   */
  const klonKok = (env.source["WORKSPACE_ROOT"] ?? "").trim();
  const gitVar = await (async (): Promise<boolean> => {
    try {
      await execFileAsync("git", ["--version"], { timeout: 10_000 });
      return true;
    } catch {
      return false;
    }
  })();

  if (klonKok === "") {
    bulgular.push({
      baslik: "Depo keşfi (klon)",
      seviye: "kritik",
      sonuc:
        "WORKSPACE_ROOT tanımlı DEĞİL — hiçbir koşu depoyu klonlamaz ve analiz kod tabanını GÖRMEDEN yazılır. " +
        "Bu bir çökme üretmez; çıktı sessizce eksilir.",
      cozum:
        '.env\'e WORKSPACE_ROOT="/workspace" yazın (compose bu yolu bff ve worker\'a bağlar). Özel depolar için ayrıca ' +
        "SCM_TOKEN_REF'i doldurun; github.com dışı bir SCM için SCM_HOST. Sonra: docker compose up -d bff worker",
    });
  } else if (!gitVar) {
    bulgular.push({
      baslik: "Depo keşfi (klon)",
      seviye: "kritik",
      sonuc:
        `WORKSPACE_ROOT dolu (${klonKok}) ama bu konteynerde git YOK — klon komutu hiç çalışamaz. ` +
        'Hata koşuda "clone failed" diye görünür, ki bu yetki ya da ağ sorunu gibi okunur.',
      cozum:
        "Bu, imajın eksikliğidir; yapılandırmayla düzelmez. git taşıyan bir sürüme geçin (1.0.72 ve sonrası) ve " +
        "servisleri yeniden başlatın.",
    });
  } else {
    const jetonRefScm = (env.source["SCM_TOKEN_REF"] ?? "").trim();
    bulgular.push({
      baslik: "Depo keşfi (klon)",
      seviye: "iyi",
      sonuc:
        `AÇIK — klon kökü ${klonKok}, git kurulu. ` +
        (jetonRefScm === ""
          ? "SCM_TOKEN_REF boş: yalnız herkese açık depolar inebilir."
          : `SCM_TOKEN_REF tanımlı (referans: ${jetonRefScm}; değer yazılmadı).`),
      ...(jetonRefScm === ""
        ? {
            cozum:
              "Özel bir depo klonlanacaksa SCM_TOKEN_REF'i doldurun; boşken özel depo klonu kimlik doğrulaması olmadan reddedilir.",
          }
        : {}),
    });
  }

  // ── Webhook gizli anahtarı ────────────────────────────────────────────────
  // YALNIZ VARLIK. Değeri okumaya bile kalkmıyoruz: bu sayfa gönderilecek.
  const webhookRef = (env.source["JIRA_WEBHOOK_SECRET_REF"] ?? "").trim();
  bulgular.push(
    webhookRef === ""
      ? {
          baslik: "Webhook gizli anahtarı",
          seviye: "uyari",
          sonuc: "JIRA_WEBHOOK_SECRET_REF tanımsız — gelen webhook imzası doğrulanamaz.",
          cozum:
            "Webhook kullanmıyorsanız (kapalı ağ, yalnız tarama) bu bir sorun değildir. Kullanıyorsanız .env'de JIRA_WEBHOOK_SECRET_REF'i doldurup sırrı sır deposuna yazın.",
        }
      : {
          baslik: "Webhook gizli anahtarı",
          seviye: "iyi",
          sonuc: `JIRA_WEBHOOK_SECRET_REF tanımlı (referans: ${webhookRef}; değer yazılmadı).`,
        },
  );

  // Jeton referansları — yine yalnız varlık.
  const jetonRef = dolu("JIRA_TOKEN_REF");
  bulgular.push({
    baslik: "Jira jeton referansı",
    seviye: jetonRef ? "iyi" : "kritik",
    sonuc: jetonRef ? "JIRA_TOKEN_REF tanımlı (değer yazılmadı)." : "JIRA_TOKEN_REF TANIMSIZ.",
    ...(jetonRef
      ? {}
      : {
          cozum:
            "Jira'ya yapılan her çağrı kimliksiz gider ve 401 döner. .env'de JIRA_TOKEN_REF'i doldurun ya da panelden Jira bağlantısı ekleyip jetonu oraya girin.",
        }),
  });

  // ── Migration sayısı ──────────────────────────────────────────────────────
  // install.sh imajdaki DOSYA sayısını sayar; burada VERİTABANINA uygulanmış
  // olanı sayıyoruz — iki farklı soru, ve ikincisi kurulum sonrası tek anlamlı
  // olan. (İmaj güncel, migrate koşmamış → tam olarak bu ayrım.)
  try {
    const satirlar = await db.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT count(*)::bigint AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`,
    );
    const uygulanan = Number(satirlar[0]?.count ?? 0);
    bulgular.push(
      uygulanan >= options.beklenenMigration
        ? {
            baslik: "Veritabanı şeması (migration)",
            seviye: "iyi",
            sonuc: `${String(uygulanan)} migration uygulanmış (asgari ${String(options.beklenenMigration)}).`,
          }
        : {
            baslik: "Veritabanı şeması (migration)",
            seviye: "kritik",
            sonuc: `Yalnız ${String(uygulanan)} migration uygulanmış; en az ${String(options.beklenenMigration)} bekleniyordu.`,
            cozum:
              "İmaj güncel ama migrate koşmamış ya da yarıda kalmış olabilir. Çalıştırın: docker compose run --rm migrate — sonra: docker compose logs migrate",
          },
    );
  } catch (error) {
    bulgular.push({
      baslik: "Veritabanı şeması (migration)",
      seviye: "bilinmiyor",
      sonuc: `Migration tablosu okunamadı: ${hataMetni(error)}`,
    });
  }

  // ── Dinleme kuralları ─────────────────────────────────────────────────────
  // Kaç kural, kapsamları ne, statü haritası dolu mu. Kural yoksa tarama
  // çalışsa bile aranacak bir şey yoktur — kritik.
  try {
    const kurallar = await db.listeningRule.findMany({ orderBy: { priority: "asc" } });
    const acik = kurallar.filter((k) => k.enabled);
    if (acik.length === 0) {
      bulgular.push({
        baslik: "Dinleme kuralları",
        seviye: "kritik",
        sonuc: `Açık dinleme kuralı YOK (toplam ${String(kurallar.length)}) — aranacak bir şey yok.`,
        cozum:
          "Tarama çalışsa bile hiçbir ticket eşleşmez. Panel → Kurulum sihirbazı ile projeyi bağlayın ve bir kural oluşturun.",
      });
    } else {
      const haritali = acik.filter((k) => k.statusMapJson !== null && k.statusMapJson !== undefined).length;
      const kapsam = acik
        .map((k) => `${k.projectKey} · ${k.matchKind}=${k.matchValue} → ${k.flowType}`)
        .join(" | ");
      bulgular.push({
        baslik: "Dinleme kuralları",
        seviye: "iyi",
        sonuc: `${String(acik.length)} açık kural (toplam ${String(kurallar.length)}). Kapsam: ${kapsam}`,
      });
      bulgular.push(
        haritali === 0
          ? {
              baslik: "Statü haritası",
              seviye: "uyari",
              sonuc: "Hiçbir kuralda statü haritası yok — yorum-anlatım kipi.",
              cozum:
                "Bu bir kusur değil bir tercih: Maestro ilerlemeyi yorumlarla anlatır ve panoya hiç dokunmaz. Ticket'ların otomatik statü değiştirmesini istiyorsanız panelden kuralın statü haritasını doldurun.",
            }
          : {
              baslik: "Statü haritası",
              seviye: "iyi",
              sonuc: `${String(haritali)}/${String(acik.length)} açık kuralda statü haritası tanımlı.`,
            },
      );
    }
  } catch (error) {
    bulgular.push({
      baslik: "Dinleme kuralları",
      seviye: "bilinmiyor",
      sonuc: `Kural tablosu okunamadı: ${hataMetni(error)}`,
    });
  }

  // ── Jira bağlantısı (panel) ───────────────────────────────────────────────
  // Adres MASKELENEREK yazılır: bir base URL userinfo taşıyabilir ve bu sayfa
  // gönderiliyor. Maskeleme `maskEndpointCredentials` ile — bu depoda o iş için
  // yazılmış, URL'i yapısal ayrıştıran tek fonksiyon.
  try {
    const hepsi = await connections.list();
    const jira = hepsi.filter((c) => c.kind === "jira_cloud" || c.kind === "jira_dc");
    if (jira.length === 0) {
      bulgular.push({
        baslik: "Jira bağlantısı (panel)",
        seviye: "uyari",
        sonuc: "Panelde tanımlı Jira bağlantısı YOK.",
        cozum:
          "İş portu .env'deki iki adresten kurulur, yani bağlantısız da çalışabilir; ama bot kimliği ve sihirbazın okuma çağrıları buradan gelir. Panel → Ayarlar > Bağlantılar.",
      });
    } else {
      for (const baglanti of jira) {
        const adres = maskEndpointCredentials(baglanti.baseUrl) ?? "(adres yok)";
        const test =
          baglanti.lastTestOk === true
            ? "son test BAŞARILI"
            : baglanti.lastTestOk === false
              ? "son test BAŞARISIZ"
              : "hiç test edilmedi";
        const sorunlu = !baglanti.enabled || baglanti.lastTestOk !== true;
        bulgular.push({
          baslik: `Jira bağlantısı: ${baglanti.id}`,
          seviye: sorunlu ? "uyari" : "iyi",
          sonuc: `${baglanti.kind} → ${adres} · ${baglanti.enabled ? "açık" : "KAPALI"} · ${test}`,
          ...(sorunlu
            ? { cozum: "Panel → Ayarlar > Bağlantılar → bu bağlantıyı açın ve 'Test et' düğmesine basın." }
            : {}),
        });
      }
    }
  } catch (error) {
    bulgular.push({
      baslik: "Jira bağlantısı (panel)",
      seviye: "bilinmiyor",
      sonuc: `Bağlantı tablosu okunamadı: ${hataMetni(error)}`,
    });
  }

  return bulgular;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2 · Akış
// ─────────────────────────────────────────────────────────────────────────────

/** Kaç koşu, hangi adımda, 2b'de bekleyen kimler, Temporal ne diyor. */
async function akisBolumu(db: Db, temporalAdres: string, namespace: string): Promise<AkisBolumu> {
  const bicimle = (row: {
    id: string;
    ticketKey: string;
    step: string;
    status: string;
    updatedAt: Date;
  }): KosuSatiri => ({
    id: row.id,
    ticketKey: row.ticketKey,
    step: row.step,
    status: row.status,
    updatedAt: row.updatedAt.toISOString().replace("T", " ").slice(0, 19),
  });

  let toplam = 0;
  let adimDagilimi: (readonly [string, number])[] = [];
  let netlestirmeBekleyen: KosuSatiri[] = [];
  let sonKosular: KosuSatiri[] = [];
  /**
   * KAPIDA/BEKLEMEDE görünen koşular — kayıp koşu kıyasının SOL tarafı.
   *
   * Terminal olmayan her koşu: bunların Temporal'da bir execution'ı OLMALI.
   * Olmayanı "kayıp"tır ve uyandırılamaz — bkz. `AkisBolumu.kayipKosular`.
   */
  let bekleyen: KosuSatiri[] = [];
  try {
    toplam = await db.workflowRun.count();
    const gruplar = await db.workflowRun.groupBy({ by: ["step"], _count: { _all: true } });
    adimDagilimi = gruplar
      .map((g) => [g.step, g._count._all] as const)
      .sort((a, b) => a[0].localeCompare(b[0]));
    // 2b = netleştirme, insan cevabı beklenen kapı (packages/contracts/src/workflow.ts).
    // BİTMİŞ koşular dışarıda: 2b'den geçmiş ve tamamlanmış bir koşu beklemiyor.
    netlestirmeBekleyen = (
      await db.workflowRun.findMany({
        where: { step: "2b", status: { in: ["running", "gate", "queued"] } },
        orderBy: { updatedAt: "desc" },
        take: 100,
      })
    ).map(bicimle);
    sonKosular = (await db.workflowRun.findMany({ orderBy: { updatedAt: "desc" }, take: 40 })).map(bicimle);
    bekleyen = (
      await db.workflowRun.findMany({
        where: { status: { notIn: ["done", "cancelled"] } },
        orderBy: { updatedAt: "desc" },
        // Yoklamanın kendi penceresiyle aynı üst sınır: kıyas, sistemin
        // gerçekten izlediği kümenin üstünde yapılmalı.
        take: 200,
      })
    ).map(bicimle);
  } catch {
    // Tablolar okunamadı — bölüm boş kalır, yapılandırma bulgusu zaten söylüyor.
  }

  // Temporal: BFF'in kullandığı geçidin `list` metodu, `onlyRunning` ile.
  // Ayrı bir istemci kurmak, "açık workflow" tanımının iki yerde ayrışmasına
  // açık kapı bırakırdı.
  try {
    const { gateway, close } = await connectTemporal({ address: temporalAdres, namespace });
    try {
      const acik = await gateway.list({ onlyRunning: true, limit: 200 });
      /**
       * KIYAS. Temporal'ın açık execution kümesinde OLMAYAN her bekleyen koşu
       * kayıptır: uyandırılamaz, ve dışarıdan hiçbir belirtisi yok.
       *
       * Ticket anahtarıyla eşleştiriliyor, workflow id'siyle değil — geçidin
       * `list`i zaten `ticketOf` ile anahtarı çıkarıyor ve ikinci bir id
       * türetme kuralı yazmak, iki kuralın ayrışmasına açık kapı bırakırdı.
       */
      const acikTicketlar = new Set(acik.map((kosu) => kosu.ticketKey));
      const kayipKosular = bekleyen.filter((kosu) => !acikTicketlar.has(kosu.ticketKey));
      // `null` (süre okunamadı) ile `undefined` (hiç sorulmadı) aynı yere
      // düşüyor: ikisi de "raporda gösterme" demek, ve iki farklı boşluk
      // göstermenin okuyucuya söyleyeceği bir şey yok.
      // Tek RPC, iki alan: metin operatöre, saniye raporun "bu süre kısa"
      // kıyasına (`tani.ts` → `saklamaUyarisi`). İkisi de aynı okumadan
      // türediği için ekrandaki süre ile uyarı ayrışamaz.
      const saklamaSaniye = (await gateway.saklamaSaniye().catch(() => null)) ?? undefined;
      const saklama = saklamaSaniye === undefined ? undefined : insanOkunur(saklamaSaniye);
      return {
        toplam,
        adimDagilimi,
        netlestirmeBekleyen,
        sonKosular,
        temporalAcik: acik.length,
        kayipKosular,
        ...(saklama === undefined ? {} : { saklamaSuresi: saklama }),
        ...(saklamaSaniye === undefined ? {} : { saklamaSaniye }),
      };
    } finally {
      await close();
    }
  } catch (error) {
    return {
      toplam,
      adimDagilimi,
      netlestirmeBekleyen,
      sonKosular,
      temporalAcik: null,
      // Temporal okunamadı: kıyas YAPILAMADI. `[]` yazmak "kayıp yok" demek
      // olurdu ve o, ölçülmemiş bir şeyi sağlıklı ilan etmektir.
      kayipKosular: null,
      temporalHata: hataMetni(error),
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3 · Canlı Jira
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Jira'ya gerçekten gidip dört OKUMA çağrısını dener.
 *
 * YAZMA YOKTUR ve bu tartışmaya kapalı. Statü geçişi de yalnızca LİSTELENİR
 * (`readAvailableTransitions` → `GET .../transitions`): bir tanı aracının
 * bankanın panosunda bir ticket'ı oynatması kabul edilemez.
 *
 * Örnek ticket yoksa ticket'a bağlı üç deneme ATLANIR ve bu sayfada adıyla
 * söylenir — sessizce "başarılı" saymak, aracın verebileceği en yanlış cevap.
 */
async function jiraBolumu(
  workPort: unknown,
  ornekTicket: string | null,
  maskele: (s: string) => string,
): Promise<JiraBolumu> {
  const denemeler: JiraDeneme[] = [];
  const port = workPort as Record<string, unknown>;

  const dene = async (ad: string, cagri: () => Promise<string>): Promise<void> => {
    try {
      denemeler.push({ ad, durum: "basarili", aciklama: maskele(await cagri()) });
    } catch (error) {
      const kod = httpKodu(error);
      denemeler.push({
        ad,
        durum: "basarisiz",
        ...(kod === undefined ? {} : { httpKodu: kod }),
        aciklama: maskele(hataMetni(error)),
      });
    }
  };

  if (ornekTicket === null) {
    denemeler.push({
      ad: "getTicket",
      durum: "atlandi",
      aciklama:
        "Bilinen bir ticket anahtarı yok (veritabanında koşu yok ve --ticket verilmedi) — okuma denenemedi.",
    });
    denemeler.push({ ad: "listComments", durum: "atlandi", aciklama: "Aynı sebeple atlandı." });
    denemeler.push({ ad: "transitions (yalnız listeleme)", durum: "atlandi", aciklama: "Aynı sebeple atlandı." });
  } else {
    const key = ornekTicket as TicketKey;
    await dene("getTicket", async () => {
      const snapshot = (await (port["getTicket"] as (k: TicketKey) => Promise<unknown>)(key)) as {
        status?: unknown;
      };
      return `${ornekTicket} okundu (statü: ${String(snapshot.status ?? "?")}).`;
    });

    if (canReadComments(workPort)) {
      await dene("listComments", async () => {
        const yorumlar = await workPort.listComments(key);
        return `${ornekTicket} için ${String(yorumlar.length)} yorum okundu.`;
      });
    } else {
      denemeler.push({
        ad: "listComments",
        durum: "sunulmuyor",
        aciklama: "Bu sürücü yorum okumayı sunmuyor — /approve yalnız webhook ile alınabilir.",
      });
    }

    if (typeof port["readAvailableTransitions"] === "function") {
      await dene("transitions (yalnız listeleme)", async () => {
        const gecisler = (await (
          port["readAvailableTransitions"] as (k: TicketKey) => Promise<unknown[]>
        )(key)) as { name?: unknown }[];
        const adlar = gecisler.map((g) => String(g.name ?? "?")).join(", ");
        return `${String(gecisler.length)} geçiş listelendi${adlar === "" ? "" : `: ${adlar}`}. HİÇBİRİ UYGULANMADI.`;
      });
    } else {
      denemeler.push({
        ad: "transitions (yalnız listeleme)",
        durum: "sunulmuyor",
        aciklama: "Bu sürücü geçiş okumayı sunmuyor — statü haritası bu kurulumda sessizce hiçbir şey yapmaz.",
      });
    }
  }

  // Arama, ticket'tan bağımsız: kendi JQL'ini kurar. Webhook'suz kurulumda
  // ticket'ın girebildiği TEK kapı bu, o yüzden atlanamaz.
  if (canSearch(workPort)) {
    await dene("searchIssues (JQL)", async () => {
      const sayfa = (await workPort.searchIssues({ jql: "order by created DESC", maxResults: 1 })) as {
        issues?: unknown[];
        total?: unknown;
      };
      const toplam = typeof sayfa.total === "number" ? String(sayfa.total) : "?";
      return `Arama çalışıyor — sorgu ${toplam} sonuç bildirdi (1 tanesi çekildi).`;
    });
  } else {
    denemeler.push({
      ad: "searchIssues (JQL)",
      durum: "sunulmuyor",
      aciklama:
        "Bu sürücü arama SUNMUYOR — ticket taraması bu kurulumda hiç çalışamaz. Webhook yoksa hiçbir ticket akışa giremez.",
    });
  }

  return { denemeler };
}

// ─────────────────────────────────────────────────────────────────────────────
// Ana akış
// ─────────────────────────────────────────────────────────────────────────────

/**
 * install.sh'in imajda saydığı asgari migration sayısıyla AYNI sayı.
 *
 * İki yerde yazılı olması hoş değil ama kaçınılmaz: install.sh bir kabuk
 * betiği, burası TypeScript, ve ikisi de derleyicinin okumadığı bir sabit
 * taşıyor. `apps/deploy/test/tani-bundle.test.ts` bu sayıyı hem install.sh'in
 * literaline hem gerçek migration klasörüne karşı kilitliyor — sayı ancak
 * üçü birden güncellenirse geçer.
 */
export const BEKLENEN_MIGRATION = 31;

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const jiraKapali = argv.includes("--jira-yok");
  const url = required(process.env["DATABASE_URL"], "DATABASE_URL");
  const girdi = await stdinOku();

  const db = createDb(url);
  try {
    const connections = new PrismaConnectionStore(db.connection);
    // Yığının kendi kablolaması, BFF'in kurduğu şekilde: panelden girilen
    // jeton .env'in önüne geçer, TLS kuralı bağlantı başına okunur. Aynı
    // fabrikalar, çünkü tanı aracının denediği çağrı, sistemin yaptığı
    // çağrının AYNISI olmalı — yoksa "bende çalıştı" raporu üretir.
    const { env, deployment } = await bootPlatform({
      sql: prismaSqlExecutor(db),
      connectionSecrets: connectionSecretsFrom(db),
      tlsSkipFlag: tlsSkipFlagFrom(db),
      quiet: true,
    });
    const workPort: unknown = deployment.ports.work;
    const driver = deployment.selection.work.driver;

    const bulgular = await yapilandirmaBulgulari({
      env,
      driver,
      wiringNote: workWiringNote(env, driver),
      workPort,
      db,
      connections,
      beklenenMigration: BEKLENEN_MIGRATION,
    });

    const akis = await akisBolumu(
      db,
      env.source["TEMPORAL_ADDRESS"] ?? "temporal:7233",
      env.source["TEMPORAL_NAMESPACE"] ?? "default",
    );

    const maskele = (satir: string): string =>
      maskeleSatir(satir, (dsn) => maskEndpointCredentials(dsn) ?? dsn);

    // Örnek ticket: operatör verdiyse o, yoksa veritabanındaki en son koşunun
    // ticket'ı. İkisi de yoksa ticket'a bağlı denemeler atlanır — uydurma bir
    // anahtarla 404 alıp "Jira bozuk" demek, teşhis değil gürültüdür.
    const ornekTicket =
      metin(girdi.ornekTicket, "") !== ""
        ? metin(girdi.ornekTicket, "")
        : (akis.sonKosular[0]?.ticketKey ?? null);

    const jira =
      jiraKapali || girdi.jiraTesti === false
        ? { atlandiSebep: "Canlı Jira testi atlandı (--jira-yok).", denemeler: [] }
        : driver === "not-configured"
          ? {
              atlandiSebep:
                "İş sürücüsü yapılandırılmadı (yukarıdaki 1. bölüme bakın) — denenecek bir Jira yok.",
              denemeler: [],
            }
          : await jiraBolumu(workPort, ornekTicket, maskele);

    const servisler: ServisLogu[] = [];
    const dikkat: DikkatSatiri[] = [];
    for (const [servis, satirlar] of loglariOku(girdi.loglar)) {
      const ayiklanan = logAyikla(servis, satirlar, maskele);
      servisler.push(ayiklanan.log);
      dikkat.push(...ayiklanan.dikkat);
    }

    const rapor: TaniRaporu = {
      kunye: {
        uretimZamani: metin(girdi.uretimZamani, new Date().toISOString().replace("T", " ").slice(0, 19)),
        hostAdi: metin(girdi.hostAdi, "(bilinmiyor)"),
        imajSurumu: metin(girdi.imajSurumu, "(bilinmiyor)"),
        satirSayisi: typeof girdi.satirSayisi === "number" ? girdi.satirSayisi : 200,
      },
      yapilandirma: { bulgular },
      akis,
      jira,
      log: { servisler, dikkat },
    };

    /**
     * Rapor NEREYE gider: `--out <yol>` verilmişse dosyaya, yoksa stdout'a.
     *
     * Prod'da rapor bir DOSYA olarak isteniyor — operatör onu indirip
     * paylaşabilsin diye. `> rapor.html` ile yönlendirmek de çalışır ama iki
     * şeyi bozar: çıkış kodu kaybolur (kritik bulgu sinyali), ve konteyner
     * içinde çalışan bir komutta kabuk yönlendirmesi her zaman elde değildir.
     * Bayrak ikisini de çözer; yol yazılamıyorsa stdout'a düşer, çünkü
     * yazılamayan bir dosya yüzünden teşhisin KAYBOLMASI en kötü sonuç olurdu.
     */
    const html = taniHtml(rapor);
    const outIdx = process.argv.indexOf("--out");
    const outPath = outIdx >= 0 ? process.argv[outIdx + 1] : undefined;
    if (outPath !== undefined && outPath !== "") {
      try {
        const { writeFile, mkdir } = await import("node:fs/promises");
        const { dirname } = await import("node:path");
        await mkdir(dirname(outPath), { recursive: true });
        await writeFile(outPath, html, "utf8");
        process.stderr.write(`[maestro] tanı raporu yazıldı: ${outPath}\n`);
      } catch (error) {
        process.stderr.write(`[maestro] tanı raporu "${outPath}" yazılamadı (${String(error)}); rapor aşağıda.\n`);
        process.stdout.write(html);
      }
    } else {
      process.stdout.write(html);
    }

    // Çıkış kodu betiğin operatöre ne diyeceğini belirler: 3 = kritik bulgu
    // VAR (rapor yine üretildi), tıpkı ajan-modelleri.sh'in 3'ü gibi.
    return bulgular.some((b) => b.seviye === "kritik") ? 3 : 0;
  } finally {
    await db.$disconnect();
  }
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.trim().length === 0) throw new Error(`${name} tanımlı değil`);
  return value;
}

if (isEntrypoint(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exit(1);
    });
}
