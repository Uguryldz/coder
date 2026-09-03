/**
 * TEMPORAL SAKLAMA SÜRESİ — İMAJIN KENDİSİ AYARLIYOR.
 *
 * ── Neden bu dosya var: ölçülmüş, sessiz veri kaybı ─────────────────────────
 * Temporal'ın namespace varsayılanı 24 SAAT ve bu süre koşunun GEÇMİŞİNE
 * uygulanır. Bu kurulumda 4. ve 5. kapıda insan onayı bekleyen 12 koşunun
 * execution'ı Temporal'dan düşmüştü: `tctl workflow describe` "workflow not
 * found" derken `WorkflowRun` satırı hâlâ "running" gösteriyordu. Kapıda
 * bekleyen iş, kimse hiçbir şey yapmadan, sessizce kayboldu.
 *
 * Maestro'nun akışı GÜNLER sürer ve bu tasarımın kendisidir: netleştirme
 * beklemesi ve onay kapıları SÜRESİZDİR (M61 — otomatik reddetme yok, zaman
 * aşımı yok). Saklama süresi iş akışının kendi ölçeğinin ALTINDA olamaz.
 *
 * ── Neden compose ve install.sh yetmedi ─────────────────────────────────────
 * compose'daki `DEFAULT_NAMESPACE_RETENTION` yalnız namespace İLK
 * YARATILIRKEN okunur; kurulmuş bir sistemde hiçbir şey yapmaz. Geriye
 * `install.sh`'ın `tctl namespace update` adımı kalıyordu — ama o, operatörün
 * sunucuda bir betik çalıştırmasını şart koşar. Operatörün ifadesi:
 * "install.sh çalıştırmayacağım, sen imaj içinden çağır".
 *
 * Bu yüzden ayar artık ÜRÜNÜN KENDİ AÇILIŞINDA yapılıyor: worker her
 * kalktığında namespace'in süresini okur, kısaysa uzatır. Operatörün hiçbir
 * şey yapması gerekmiyor — imajı çekip `docker compose up` demek yetiyor.
 *
 * ── Neden `tctl` değil de SDK ───────────────────────────────────────────────
 * `tctl` yalnız Temporal konteynerinde var; Node imajından çağırmak
 * `docker exec` demektir, yani uygulama konteynerine Docker soketi vermek.
 * Bir bankada bu, saklama süresi ayarı uğruna verilecek en pahalı yetkidir.
 * `WorkflowService.updateNamespace` aynı işi zaten açık olan gRPC bağlantısı
 * üzerinden yapar; `tctl`in kendisi de bu RPC'yi çağırır.
 */

import type { Connection } from "@temporalio/client";

/**
 * Ürünün istediği asgari saklama süresi: 90 gün.
 *
 * 30 gün "çoğu kapı için yeter" demektir ve o "çoğu" tam olarak kaybedilecek
 * olanı dışarıda bırakır: yıllık izne çıkmış tek onaycının ticket'ı. 90 gün
 * bir çeyreklik takvimin tamamını kapsar.
 */
export const VARSAYILAN_SAKLAMA = "2160h";

/** Bir günün saniyesi — okunurluk için, sihirli sayı bırakmamak adına. */
const GUN = 86_400;

/**
 * `TEMPORAL_RETENTION` biçimini saniyeye çevirir: `2160h`, `90d`, `5400m`.
 *
 * compose ve `install.sh` yıllardır `2160h` yazıyor; aynı metni bu taraf da
 * anlamak zorunda, yoksa operatörün `.env`'de değiştirdiği değer sessizce yok
 * sayılırdı. Tanınmayan biçim `null` döner ve çağıran varsayılana düşer —
 * bir yazım hatası yüzünden saklama süresini 24 saatte bırakmak, bu dosyanın
 * var oluş sebebinin tam tersi olurdu.
 */
export function saniyeyeCevir(deger: string): number | null {
  const eslesme = /^\s*(\d+(?:\.\d+)?)\s*([smhd])\s*$/i.exec(deger);
  if (eslesme === null) return null;
  const sayi = Number(eslesme[1]);
  if (!Number.isFinite(sayi) || sayi <= 0) return null;
  const carpan = { s: 1, m: 60, h: 3600, d: GUN }[eslesme[2]?.toLowerCase() ?? ""];
  if (carpan === undefined) return null;
  return Math.round(sayi * carpan);
}

/** Saniyeyi operatörün okuyabileceği hâle getirir ("24 saat", "90 gün"). */
export function insanOkunur(saniye: number): string {
  const saat = Math.round(saniye / 3600);
  // Günden kısa süreler saatle, uzunlar günle: "2160h" bir operatöre hiçbir
  // şey söylemez, "90 gün" ise akışının ölçeğiyle doğrudan kıyaslanabilir.
  return saat < 48 ? `${String(saat)} saat` : `${String(Math.round(saat / 24))} gün`;
}

/** Bu geçişte ne olduğu — çağıran loglar, testler doğrular. */
export type SaklamaSonucu =
  | { readonly durum: "guncellendi"; readonly oncekiSaniye: number | null; readonly yeniSaniye: number }
  | { readonly durum: "zaten_yeterli"; readonly mevcutSaniye: number }
  | { readonly durum: "yapilamadi"; readonly sebep: string };

/**
 * `updateNamespace`/`describeNamespace` için gereken en dar yüzey.
 *
 * `Connection` tipinin tamamı yerine bu: test bir gRPC istemcisi kurmak
 * zorunda kalmasın, ve bu dosya Temporal istemcisinin başka hiçbir yeteneğine
 * erişemesin.
 */
export interface NamespaceServisi {
  describeNamespace(request: {
    namespace: string;
  }): Promise<{ config?: { workflowExecutionRetentionTtl?: { seconds?: unknown } | null } | null }>;
  updateNamespace(request: {
    namespace: string;
    config: { workflowExecutionRetentionTtl: { seconds: number } };
  }): Promise<unknown>;
}

/**
 * Saklama süresini İSTENEN değerin altındaysa yükseltir.
 *
 * ── İDEMPOTENT ─────────────────────────────────────────────────────────────
 * Önce okur. Mevcut süre zaten istenen kadar ya da daha uzunsa HİÇBİR ŞEY
 * YAZMAZ ve `zaten_yeterli` döner. Yani worker günde on kez yeniden başlasa
 * da namespace'e tek bir yazma gitmez.
 *
 * ── NEDEN "ALTINDAYSA", "EŞİT DEĞİLSE" DEĞİL ───────────────────────────────
 * Bir bankanın denetim birimi saklama süresini 180 güne çıkarmış olabilir.
 * "İstenen değere eşitle" mantığı onu her açılışta 90 güne GERİ ÇEKERDİ — ve
 * bir kurumun bilerek uzattığı saklama süresini bir uygulama açılışının
 * sessizce kısaltması, bu dosyanın önlemeye çalıştığı kaybın ta kendisidir.
 * Bu yüzden yalnız YUKARI doğru hareket eder.
 *
 * ── FAIL-SOFT ──────────────────────────────────────────────────────────────
 * Hiçbir dalı fırlatmaz. Temporal henüz hazır değilse, RPC yetkisi yoksa ya
 * da namespace okunamıyorsa `yapilamadi` döner ve çağıran uyarıp devam eder.
 * Saklama süresi ayarlanamadı diye worker'ın kuyruğu yoklamayı reddetmesi,
 * bankayı teslimatsız bırakmak olurdu — bkz. `reconcileOnBoot`, aynı kural.
 */
export async function saklamaSuresiniGuvence(
  servis: NamespaceServisi,
  namespace: string,
  istenenSaniye: number,
): Promise<SaklamaSonucu> {
  let mevcut: number | null;
  try {
    const cevap = await servis.describeNamespace({ namespace });
    mevcut = sayiya(cevap.config?.workflowExecutionRetentionTtl?.seconds);
  } catch (hata) {
    return { durum: "yapilamadi", sebep: metin(hata) };
  }

  if (mevcut !== null && mevcut >= istenenSaniye) {
    return { durum: "zaten_yeterli", mevcutSaniye: mevcut };
  }

  try {
    await servis.updateNamespace({
      namespace,
      config: { workflowExecutionRetentionTtl: { seconds: istenenSaniye } },
    });
  } catch (hata) {
    return { durum: "yapilamadi", sebep: metin(hata) };
  }
  return { durum: "guncellendi", oncekiSaniye: mevcut, yeniSaniye: istenenSaniye };
}

/**
 * Açılış adımının tamamı: ortamı oku, ayarla, TÜRKÇE olarak ne olduğunu söyle.
 *
 * Log Türkçe, çünkü bu satırları okuyacak kişi `install.sh`'ın Türkçe
 * konuştuğu operatörün aynısı — ve "operatörün hiçbir şey yapmasına gerek
 * yok" iddiasının tek kanıtı bu satırlardır.
 */
export async function saklamaSuresiniAcilistaAyarla(options: {
  readonly servis: NamespaceServisi;
  readonly namespace: string;
  /** Ham `TEMPORAL_RETENTION` değeri; yoksa/bozuksa `VARSAYILAN_SAKLAMA`. */
  readonly istenen?: string | undefined;
  readonly log?: { info: (satir: string) => void; warn: (satir: string) => void };
}): Promise<SaklamaSonucu> {
  const log = options.log ?? console;
  const ham = options.istenen?.trim();
  const cozulen = ham === undefined || ham === "" ? null : saniyeyeCevir(ham);
  if (ham !== undefined && ham !== "" && cozulen === null) {
    log.warn(
      `[maestro] TEMPORAL_RETENTION okunamadı ("${ham}") — beklenen biçim "2160h" / "90d". ` +
        `${VARSAYILAN_SAKLAMA} varsayılanı kullanılıyor.`,
    );
  }
  const istenenSaniye = cozulen ?? (saniyeyeCevir(VARSAYILAN_SAKLAMA) as number);

  const sonuc = await saklamaSuresiniGuvence(options.servis, options.namespace, istenenSaniye);
  if (sonuc.durum === "guncellendi") {
    const onceki = sonuc.oncekiSaniye === null ? "okunamadı" : insanOkunur(sonuc.oncekiSaniye);
    log.info(
      `[maestro] Temporal saklama süresi ${onceki} → ${insanOkunur(sonuc.yeniSaniye)} olarak ` +
        `güncellendi (namespace: ${options.namespace}). Kapıda bekleyen koşuların geçmişi artık ` +
        `bu süre boyunca korunuyor.`,
    );
  } else if (sonuc.durum === "zaten_yeterli") {
    log.info(
      `[maestro] Temporal saklama süresi zaten ${insanOkunur(sonuc.mevcutSaniye)} ` +
        `(namespace: ${options.namespace}) — dokunulmadı.`,
    );
  } else {
    log.warn(
      `[maestro] Temporal saklama süresi AYARLANAMADI (${sonuc.sebep}). Süre 24 saatte kalmışsa ` +
        `kapıda GÜNLERCE bekleyen bir koşunun geçmişi silinir ve koşu uyandırılamaz hâle gelir. ` +
        `Worker çalışmaya devam ediyor. Elle: docker compose exec temporal tctl --address ` +
        `temporal:7233 --namespace ${options.namespace} namespace update --retention ` +
        `${VARSAYILAN_SAKLAMA}`,
    );
  }
  return sonuc;
}

/** Canlı bağlantıdan `NamespaceServisi`. Tek yerde daralt, çağıranlar bilmesin. */
export function namespaceServisi(connection: Connection): NamespaceServisi {
  return connection.workflowService as unknown as NamespaceServisi;
}

/**
 * protobuf `seconds` alanı `number`, `Long` ya da `string` gelebilir —
 * kablodan ne çıktığı istemci sürümüne bağlı. Üçünü de sayıya indirger.
 */
function sayiya(deger: unknown): number | null {
  if (deger === undefined || deger === null) return null;
  const sayi = Number(deger);
  return Number.isFinite(sayi) && sayi > 0 ? sayi : null;
}

function metin(hata: unknown): string {
  return hata instanceof Error ? hata.message : String(hata);
}
