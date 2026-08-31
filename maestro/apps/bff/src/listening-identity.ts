/**
 * DİNLEME KURALLARININ BOT KİMLİĞİ — kuralların taşıdığı kopya ile bağlantının
 * bildiği gerçek arasındaki farkı ÖLÇEN ve KAPATAN yer.
 *
 * ── NEDEN BÖYLE BİR DOSYA VAR ───────────────────────────────────────────────
 * Bir dinleme kuralı `assigneeAccountId` alanında bot hesabının bir KOPYASINI
 * taşır. Kopya bilinçli: tarama o değeri doğrudan JQL'e yapıştırıyor
 * (`assignee in (...)`) ve her tur bağlantı tablosuna gitmek, kuralın anlamını
 * çalışma zamanında değiştirilebilir kılardı — bugün bir ticket'ı alan kural,
 * yarın bağlantı düzenlendi diye sessizce başka bir kural hâline gelirdi.
 *
 * Ama kopya olduğu için AYRIŞABİLİR, ve bir kez ayrıştı:
 *
 * Data Center `/myself` cevabında kullanıcıyı iki alanla adlandırır — `name`
 * ("ugyildiz", operatörün gördüğü kullanıcı adı) ve `key` ("jirauser13506", iç
 * tutamak). Yoklama `key`i okuyordu; o değer kurallara tohumlandı; JQL ise
 * `assignee`yi KULLANICI ADIYLA çözüyor. Sonuç: atanmış ticket'larla dolu bir
 * projede her tur "0 sonuç", çünkü Jira eşleşmeyen bir kullanıcıya hata değil
 * 200 + boş sayfa cevabı veriyor. Sahada doğrulandı: atama kullanıcı adıyla
 * sorulunca ticket'lar geldi.
 *
 * `connection-service.ts` düzeltildi, ve bağlantı testi yeniden çalıştırılınca
 * `config.botAccountId` doğru değere düzeliyor. Ama MEVCUT KURALLAR kendi
 * kopyalarını taşıyor: kod düzelse de o satırlar düzelmiyor, ve düzelmezse
 * tarama düzelmiş bir bağlantının yanında hâlâ hiçbir şey bulmuyor.
 *
 * ── NEDEN OTOMATİK MİGRATION YOK ────────────────────────────────────────────
 * Bir SQL migration'ı bu veriyi düzeltemez, üç ayrı sebeple:
 *
 *  1. DOĞRU DEĞERİ BİLMİYOR. `jirauser13506` → `ugyildiz` dönüşümü hesaplanamaz;
 *     tek kaynağı Jira'nın `/myself` cevabı, yani bir AĞ çağrısı. Bir migration
 *     ağa çıkamaz (ve bankada çıkmamalı).
 *  2. DESEN BİR TAHMİN. `jirauser<sayı>` yaygın ama garanti değil: bazı DC
 *     kurulumlarında `key` gerçekten kullanıcı adına EŞİTTİR, ve orada
 *     düzeltilecek bir şey yok. Desene bakıp yazmak, doğru olan satırları da
 *     kapsama riski taşır.
 *  3. SESSİZ OLURDU. Kuralın hangi ticket'ları aldığı bu kurulumun en görünür
 *     davranışı; onu operatör bakmıyorken değiştirmek, düzeltmeye çalıştığımız
 *     sessiz-yanlışın aynısını ters yönde üretirdi.
 *
 * Onun yerine İKİ yüzey, ikisi de operatörün gözü önünde:
 *
 *  · `identityDrift` — kuralların kimliği bağlantınınkiyle uyuşuyor mu, ve
 *    `jirauser` deseni görünüyor mu. `/studio/config-health` bunu bir satır
 *    olarak gösterir: kimse bir şeye basmasa bile arıza EKRANDA yazar.
 *  · `realignRules` — operatörün BASTIĞI düğmenin işi. Bağlantının bildiği
 *    kimliği kurallara yazar, kaç kuralı değiştirdiğini söyler, ve her
 *    değişikliği denetim kaydına düşürür. Elle onlarca kural düzenlemenin
 *    alternatifi, ama yine de bir insanın kararı.
 */

import type { ConnectionRecord, ConnectionStore } from "./connection-store.js";
import type { ListeningStore } from "./listening-store.js";

/**
 * `identityDrift`in okuduğu KADARI — bir kuralın tamamı değil, tek alanı.
 *
 * Dar tutulmasının sebebi çağıranlardan biri: `apps/deploy`'un tanı raporu bu
 * ölçümü doğrudan bir Prisma `select`inden besliyor ve kuralın geri kalanını
 * (statü eşlemesi, ajan varyantları, akış) hiç okumuyor. Tam bir
 * `ListeningRuleRecord` istemek, o sorguyu yalnız tip uğruna genişletmeyi
 * dayatırdı — ve ölçümün gerçekten neye baktığını da gizlerdi.
 */
export interface RuleAssignee {
  readonly assigneeAccountId: string;
}

/**
 * Data Center'ın İÇ kullanıcı tutamağının deseni — `jirauser13506`.
 *
 * Bu bir TEŞHİS işareti, bir karar mercii DEĞİL: eşleşmesi bir kuralın kesin
 * bozuk olduğunu kanıtlamaz (nadir de olsa bir kullanıcı adı gerçekten böyle
 * olabilir), eşleşmemesi de sağlam olduğunu kanıtlamaz (bir DC `key`i
 * `JIRAUSER` öneki olmadan da üretebilir). Bu yüzden hiçbir YAZMA bu desene
 * dayanmıyor — yalnız bir uyarı metni seçiyor. Hizalama işini yapan
 * `realignRules` deseni hiç okumaz; o, bağlantının canlı olarak öğrendiği
 * değeri kaynak alır.
 */
const DC_INTERNAL_KEY = /^jirauser\d+$/i;

/** Bir değer DC iç tutamağına benziyor mu. */
export function looksLikeDcInternalKey(value: string): boolean {
  return DC_INTERNAL_KEY.test(value.trim());
}

/** Kuralların kimliği ile bağlantının bildiği kimlik arasındaki fark. */
export interface IdentityDrift {
  /** Bağlantı testinin öğrendiği kimlik, ya da hiç test edilmediyse null. */
  readonly connectionAccountId: string | null;
  /**
   * Kurallarda geçen ve bağlantınınkinden FARKLI olan kimlikler — her biri bir
   * kez, kaç kuralda geçtiğiyle. Bağlantı kimliği bilinmiyorsa boş: neyle
   * kıyaslanacağı yokken bir fark İDDİA etmek, olmayan bir arıza uydurmaktır.
   */
  readonly staleAccountIds: readonly { readonly accountId: string; readonly ruleCount: number }[];
  /** Farklı kimlik taşıyan kuralların toplamı. */
  readonly staleRuleCount: number;
  /**
   * Kurallarda DC iç tutamağı desenine benzeyen bir kimlik var mı — bağlantıyla
   * kıyastan BAĞIMSIZ. Bağlantı hiç test edilmemiş ya da o da aynı yanlış
   * değeri taşıyor olabilir; desen o durumda tek kalan işarettir.
   */
  readonly internalKeyRuleCount: number;
}

/**
 * Farkı ölç — SAF. Ağ yok, veritabanı yok, saat yok: girdi zaten okunmuş
 * kurallar ve zaten okunmuş bağlantı kimliği.
 *
 * Saf olması `config-health`in kuralının aynısı ve aynı sebeple: "bağlantı hiç
 * test edilmemişse fark İDDİA EDİLMEZ" gibi kararların birim testi olabilmesi.
 */
export function identityDrift(
  rules: readonly RuleAssignee[],
  connectionAccountId: string | null,
): IdentityDrift {
  const internalKeyRuleCount = rules.filter((rule) =>
    looksLikeDcInternalKey(rule.assigneeAccountId),
  ).length;

  // Kıyaslanacak bir gerçek yoksa, fark yoktur — "bilmiyoruz" ile "farklı"
  // arasındaki ayrım, bu ekranın inanılır kalmasının şartı. Desen sayımı yine
  // de döner: o, bağlantıdan bağımsız bir işaret.
  if (connectionAccountId === null || connectionAccountId.trim() === "") {
    return {
      connectionAccountId: null,
      staleAccountIds: [],
      staleRuleCount: 0,
      internalKeyRuleCount,
    };
  }

  const current = connectionAccountId.trim();
  const counts = new Map<string, number>();
  for (const rule of rules) {
    const held = rule.assigneeAccountId.trim();
    if (held === current) continue;
    counts.set(held, (counts.get(held) ?? 0) + 1);
  }

  return {
    connectionAccountId: current,
    // Kararlı sıra: en çok kuralda geçen kimlik önce, eşitlikte alfabetik.
    // Ekranın satırları bir istekten diğerine yer değiştirmesin.
    staleAccountIds: [...counts.entries()]
      .map(([accountId, ruleCount]) => ({ accountId, ruleCount }))
      .sort((a, b) => b.ruleCount - a.ruleCount || a.accountId.localeCompare(b.accountId)),
    staleRuleCount: [...counts.values()].reduce((sum, n) => sum + n, 0),
    internalKeyRuleCount,
  };
}

/**
 * Bağlantıların öğrendiği bot kimliği — `listening-seed.ts` ve
 * `bot-identity.ts` ile AYNI seçim kuralı: etkin bir Jira bağlantısının
 * `config.botAccountId` alanı, ilk dolu olanı.
 *
 * Aynı olması şart. Kuralları tohumlayan, yeniden girişin beklediği ve
 * hizalamanın yazdığı kimlik üç ayrı yerde ÜÇ farklı bağlantıdan seçilseydi,
 * hizalama kuralları tohumlayanın kastettiğinden başka bir hesaba taşıyabilirdi.
 */
export function botAccountIdOf(connections: readonly ConnectionRecord[]): string | null {
  for (const connection of connections) {
    if (!connection.enabled) continue;
    if (connection.kind !== "jira_cloud" && connection.kind !== "jira_dc") continue;
    const learned = connection.config["botAccountId"];
    if (typeof learned === "string" && learned.trim() !== "") return learned.trim();
  }
  return null;
}

/** Hizalamanın sonucu — neyin değiştiği, kural kural. */
export interface RealignOutcome {
  readonly ok: true;
  /** Kurallara yazılan kimlik. */
  readonly accountId: string;
  /** Değiştirilen kurallar: hangi kimlikten hangisine. */
  readonly changed: readonly {
    readonly ruleId: string;
    readonly projectKey: string;
    readonly from: string;
  }[];
  /** Zaten doğru olduğu için dokunulmayan kural sayısı. */
  readonly untouched: number;
}

export type RealignFailure =
  | { readonly ok: false; readonly reason: "bot_account_unknown" }
  | { readonly ok: false; readonly reason: "duplicate_listening_rule"; readonly ruleId: string };

/**
 * KURALLARI HİZALA — bağlantının bildiği bot kimliğini, onu taşımayan her
 * kurala yaz.
 *
 * ── NE OKUMAZ ───────────────────────────────────────────────────────────────
 * `jirauser` desenini DEĞİL. Hizalamanın sorusu "bu değer bozuk görünüyor mu"
 * değil, "bu değer bağlantının canlı olarak öğrendiği kimlik mi" — bir tahmine
 * değil, Jira'nın kendi cevabına dayanıyor. Bu sayede desene uymayan bozuk bir
 * kimlik de düzelir, ve desene uyan doğru bir kullanıcı adı yanlışlıkla
 * bozulmaz.
 *
 * ── ÇAKIŞMA ─────────────────────────────────────────────────────────────────
 * Kuralların (projectKey, assigneeAccountId, matchKind, matchValue) üzerinde
 * benzersizlik kısıtı var. Bir kuralı yeni kimliğe taşımak, aynı tetikleyiciyi
 * zaten yeni kimlikle taşıyan bir kuralla çakışabilir — operatör hem eski hem
 * yeni kimlikle kural yazdıysa. Çakışmada YARIM bırakmak yerine sebebiyle
 * durulur ve o kuralın id'si söylenir: kısmen hizalanmış bir kural kümesi,
 * hiç hizalanmamış olandan daha zor teşhis edilir.
 *
 * Not: yazma sıralı, işlem (transaction) içinde değil — `ListeningStore` bir
 * dikiş yeri ve `put`tan başkasını sunmuyor. Çakışmada önceki yazmalar durur;
 * cevap KAÇ kuralın değiştiğini söylediği için operatör nerede kalındığını
 * görür, ve işlem yeniden çalıştırılabilir (hizalama fikir olarak idempotent:
 * ikinci çalıştırma zaten doğru olanlara dokunmaz).
 */
export async function realignRules(
  listening: ListeningStore,
  connections: ConnectionStore,
): Promise<RealignOutcome | RealignFailure> {
  const accountId = botAccountIdOf(await connections.list());
  // Bağlantı hiç test edilmemiş: yazılacak bir gerçek yok. Uydurmak yerine
  // adlandırılmış bir ret — operatörün yapacağı şey bağlantı testini
  // çalıştırmak, ve cevap onu oraya gönderiyor.
  if (accountId === null) return { ok: false, reason: "bot_account_unknown" };

  const rules = await listening.list();
  const stale = rules.filter((rule) => rule.assigneeAccountId.trim() !== accountId);

  const changed: { ruleId: string; projectKey: string; from: string }[] = [];
  for (const rule of stale) {
    try {
      await listening.put({ ...rule, assigneeAccountId: accountId });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return { ok: false, reason: "duplicate_listening_rule", ruleId: rule.ruleId };
      }
      throw error;
    }
    changed.push({
      ruleId: rule.ruleId,
      projectKey: rule.projectKey,
      from: rule.assigneeAccountId,
    });
  }

  return { ok: true, accountId, changed, untouched: rules.length - stale.length };
}

/** Bir Postgres benzersizlik ihlali (Prisma P2002 ya da ham 23505). */
function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "P2002" || code === "23505";
}
