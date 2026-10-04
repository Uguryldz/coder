import { foldStatusName } from "@maestro/adapter-jira";
import type { StepId, TicketKey, WorkflowRunState } from "@maestro/contracts";
import { decideGate, type GateResult } from "./gate-decision.js";
import type { ListeningRuleRecord, StatusMap } from "./listening-store.js";
import type { ResolvedDeps } from "./deps.js";
import { projectKeyOf } from "./jira-intake.js";

/**
 * KAPI KARARININ STATÜYLE VERİLMESİ — `/approve` yorumunun yanına eklenen
 * İKİNCİ kanal.
 *
 * ── Operatörün akışı, kendi ifadesiyle ────────────────────────────────────
 * "todo => analiz => analiz onay. analizde eksik var → intake red, todo düşür.
 *  düzelttim, yorum yazdım, analize geri gönderdim. analiz başarılı → analiz
 *  onaya. insan eksik varsa geri analize gönderir, bağlam kaybı yok."
 *
 * Maestro'nun YAZMA tarafı bu döngüyü zaten sürüyordu (`statusMap`:
 * onNeedInfo → todo, onReview → analysisapproval). Eksik olan OKUMA tarafıydı:
 * operatör ticket'ı `analysisapproval`dan başka bir statüye taşıdığında kapı
 * bunu GÖRMÜYORDU. Kapıyı açan tek şey `/approve` yorumuydu, ve bir operatörün
 * kendi panosunda kartı sürüklemesi — o iş akışının doğal hareketi — hiçbir şey
 * yapmıyordu. Ticket "geliştirme"ye taşınmış görünürken koşu hâlâ 4. kapıda
 * bekliyordu.
 *
 * ── İKİ YOL DA ÇALIŞIR, biri diğerini kapatmaz ────────────────────────────
 * `/approve` yolu DEĞİŞMEDİ. Bu modül yalnız ikinci bir kanal açar; hangisi
 * önce gelirse kapıyı o kapatır, ve ikincisi geldiğinde `decideGate` kapıyı
 * kapanmış bulup `no_open_gate` der — yani çift karar üretmez.
 *
 * ── ÜÇ KATMANLI YANKI KORUMASI ────────────────────────────────────────────
 * Bu modülün var olma sebebi kadar önemli olan şey, KENDİ KENDİNİ
 * TETİKLEMEMESİ. Maestro ticket'ı kapıya girerken `onReview` statüsüne KENDİSİ
 * taşıyor (`ticket-workflow.ts`), ve `onRejected`'a da kendisi taşıyor. Bu
 * hareketlerin Jira'daki yankısı, korumasız bir okumada "operatör karar verdi"
 * diye okunurdu — kapı kendi açılışıyla kendini kapatırdı.
 *
 * `clarify-reentry.ts` aynı sorunu çözdü ve aynı üç katman burada da geçerli:
 *
 *  1. **Kimlik** (`actor !== bot`) — olayı bot'un kendisi ittiyse bu bir karar
 *     değil, kendi sesidir. Webhook yolunda uygulanır. YOKLAMA yolunda
 *     uygulanamaz (bir ticket okuması onu kimin değiştirdiğini söylemez) ve
 *     orada eksikliği 2 ve 3 taşır — `clarify-reentry` aynı ödünü verdi.
 *  2. **Yön** — hedef statü, kuralın ONAY ya da GERİ GÖNDERME noktası olmalı
 *     ({@link gateStatusesOf}). Bu noktalar operatörün hattının kendi
 *     statüleridir ve Maestro'nun taşıdığı statülerle AYNI OLABİLİR — çünkü
 *     olmaları gerekir: `development` hem "iş bitti"dir hem "onayla", `analiz`
 *     hem "iş burada yapılır"dır hem "buraya geri gönder". Tek istisna
 *     `onReview`: kapı ORADA açılıyor, dolayısıyla oradan bir karar okunamaz.
 *  3. **Zaman** (`gateOpenedSince`) — olay, kapı AÇILDIKTAN sonra alınmış
 *     olmalı, ve bu katman ölçüldüğünde tek başına belirleyici çıktı: Maestro'nun
 *     beş taşımasından DÖRDÜ (`onStart`/`onNeedInfo`/`onRejected`/`onDone`)
 *     damga BOŞKEN yapılıyor, yani `not_at_gate` ile daha ilk kontrolde
 *     eleniyorlar. Yalnız `onReview` damganın hemen öncesinde ve onu 2. katman
 *     kesiyor. Ayrıntılı ölçüm {@link gateStatusesOf} notunda.
 *
 * ── BAĞLAM ────────────────────────────────────────────────────────────────
 * Uyandırma `gateDecision` SİNYALİ ile, yeni bir `runIntake` ile değil: aynı
 * koşu devam eder, `continueAsNew` girdisi kural/akış/ajan/statü eşlemesi/
 * resume token/ret sayaçlarını taşır. Netleştirme dönüşünün deseninin aynısı.
 */

/** Statü kanalının bir olayla ne yaptığı — çağıranın loglayacağı kadarı. */
export type GateStatusReentry =
  | {
      kind: "decided";
      ticket: TicketKey;
      step: StepId;
      decision: "approve" | "return_analysis";
      /** `decideGate`'in cevabı — kapı gerçekten kapandı mı, yoksa reddedildi mi. */
      result: GateResult;
    }
  | {
      kind: "skipped";
      reason: GateStatusSkipReason;
      /**
       * Kuralın BİLDİĞİ noktalar — yalnız `not_a_gate_status` ve
       * `status_map_conflict` için dolu.
       *
       * "Ticket X'e taşındı, bu kuralda tanımlı bir rol değil" cümlesi tek
       * başına operatöre ne yapması gerektiğini SÖYLEMİYOR. Kuralın hangi
       * statüleri tanıdığını yanına yazmak, o cümleyi teşhisten talimata
       * çeviriyor: "…tanınan noktalar: onay='Development',
       * geri='Analiz'" — operatör farkı bir bakışta görür.
       */
      known?: { approve: readonly string[]; return: readonly string[] };
      /** Eşlemedeki çakışmalar — `status_map_conflict` için dolu. */
      conflicts?: readonly string[];
    };

export type GateStatusSkipReason =
  /** Issue olayı değil, ya da ticket anahtarı / statü yok. */
  | "not_issue_event"
  /** Koşu yok, ya da bir onay kapısında beklemiyor. */
  | "not_at_gate"
  /** Kapı açılış damgası yok, ya da olay ondan ÖNCE — kendi hareketinin yankısı. */
  | "before_gate_opened"
  /** Bu projede/ticket'ta kapı statüsü yapılandıran bir kural yok. */
  | "no_gate_statuses"
  /**
   * Eşleme ÇAKIŞIK: kapı statüsü `onReview` ile aynı, ya da iki kural aynı adı
   * zıt kararlara bağlamış. Kanal o karar için KAPALI — bkz.
   * {@link gateStatusesOf}.
   */
  | "status_map_conflict"
  /**
   * Ticket'ın yeni statüsü ne onay ne geri gönderme noktası — kuralda TANIMLI
   * BİR ROLÜ YOK.
   *
   * Sessizce düşmez: çağıran bunu, kuralın bildiği noktalarla birlikte
   * ({@link GateStatusReentry} `known`) loglar. Operatörün "kayıtlar
   * atlanmasın" kuralının bu kanaldaki karşılığı — bir statü hareketi geldiyse
   * ve hiçbir şey olmadıysa, NEDEN olmadığı deftere yazılmalı.
   */
  | "not_a_gate_status"
  /** Olayı bot'un kendisi itti: kendi hareketinin yankısı. */
  | "bot_echo"
  /** Teslimat kimin ittiğini söylemedi; yankı olmadığını kanıtlayamıyoruz. */
  | "actor_unknown"
  /**
   * Statü ONAY diyor ama bu kanal onayı taşıyamıyor: kararı verenin kimliği
   * okunamıyor, dolayısıyla grup üyeliği ölçülemez. Bkz. `canApprove`.
   */
  | "approval_needs_identity";

/**
 * Kuralın kapı noktaları — geri düşüşler uygulanmış, `onReview` çakışması
 * elenmiş.
 *
 * `null` alanlar "bu kural bu kararı statüyle kabul etmiyor" demek: ne açık bir
 * kapı alanı var, ne de geri düşülecek bir yazma noktası — ya da bulunan değer
 * `onReview` ile çakıştığı için düşürülmüş.
 */
export interface GateStatuses {
  approve: string | null;
  return: string | null;
  /** Düşürülen alanlar ve neyle çakıştıkları — çağıran bunu raporlamalı. */
  conflicts: readonly string[];
}

/**
 * İki statü adı aynı mı — `foldStatusName` ile, ve düz `toLowerCase()` ile DEĞİL.
 *
 * Bu bir incelik değil, bu kurulumda ölçülmüş bir arıza sınıfı. Canlı OPS iş
 * akışı inceleme sütununu "İNCELEMEDE" diye bağırıyor, panelde ise operatör
 * "İncelemede" yazıyor. Düz `toLowerCase()` "İ"yi "i̇" (i + birleşen nokta)
 * yapar ve ikisi ASLA eşleşmez; `toLocaleLowerCase("tr")` de kurtarmaz, "I"yı
 * "ı"ya eşler ve bu kez noktasızı noktalıdan ayırır.
 *
 * Burada bedeli, ÇAKIŞMA KORUMASININ SESSİZCE DELİNMESİ olurdu: operatör
 * `onRejected: "İNCELEMEDE"` ve `gateReturnStatus: "İncelemede"` yazsa, koruma
 * ikisini farklı sanır, alanı düşürmez, ve Maestro'nun kendi taşıması kendi
 * kararı olarak geri okunur — kapı kendi kendini kapatır.
 *
 * `@maestro/adapter-jira`nın kendi katlayıcısı kullanılıyor, bir kopyası değil:
 * Jira'nın statü adlarını nasıl karşılaştırdığı O paketin bilgisi, ve iki kopya
 * ayrıştığı gün ikisinden hangisinin doğru olduğu bilinmez olur.
 */
function sameStatus(left: string | undefined, right: string | undefined): boolean {
  if (left === undefined || right === undefined) return false;
  const a = foldStatusName(left);
  return a !== "" && a === foldStatusName(right);
}

/**
 * BİR KURALIN KAPI STATÜLERİ — BEŞ ALANLIK TEK HAT MODELİ.
 *
 * ── ÖNCEKİ MODEL VE NEDEN YANLIŞTI ───────────────────────────────────────
 * Bu fonksiyon eskiden YEDİ alan okuyordu (beş yazma + iki kapı) ve kapı
 * alanlarının beş yazma noktasından HERHANGİ BİRİYLE çakışmasını yasaklıyordu:
 * çakışan alan DÜŞÜYORDU. Varsayım şuydu — aynı statü hem Maestro'nun hedefi
 * hem operatörün karar sinyali olamaz.
 *
 * Sahada bu varsayım YANLIŞ çıktı. Operatörün akışı düz bir hat:
 *
 *     todo → analiz → analysisapproval → development
 *      ↑       ↑            │
 *      │       └────────────┘  (geri gönderme)
 *      └── (intake eksik bulursa)
 *
 * Bu hatta aynı statü zorunlu olarak iki rol taşır ve TAŞIMALIDIR:
 *   · `analiz`           = onStart  VE  "buraya geri gönder"
 *   · `development`      = onDone   VE  "buraya taşıyarak onayla"
 *
 * Eski koruma tam da bu DOĞRU yapılandırmayı reddediyordu — operatörün
 * gördüğü "çakışık" uyarısı buydu ve kapının statü kanalı hiç açılmıyordu.
 *
 * ── ÖLÇÜM: YANKI RİSKİ GERÇEKTE NEREDE ───────────────────────────────────
 * Korumanın gerekçesi "Maestro'nun kendi taşıması kendi kararı olarak geri
 * okunur"du. Maestro'nun BEŞ taşımasının her biri, kapı damgası
 * (`gateOpenedSince`) açısından ölçüldü:
 *
 *   · `onStart`     — adım 3ö öncesi. Kapı henüz AÇILMADI, damga yok.
 *   · `onNeedInfo`  — adım 2b. Kapı henüz açılmadı, damga yok.
 *   · `onReview`    — kapı setine girerken, ve damga BUNDAN SONRA atılıyor
 *                     (`gate-loop.ts`: `openGate` → `state.gateOpenedSince =
 *                     workflowNow()`). Yani bu taşımanın yankısı eşiğin
 *                     GERİSİNDE kalır — ama kıl payı, ve tek gerçek risk bu.
 *   · `onRejected`  — YALNIZ `reject` dalında, ve o dal kapı KAPANDIKTAN
 *                     sonra çalışıyor (`gate-loop.ts` kapanışta
 *                     `gateOpenedSince = null` yapıyor). `return_analysis`
 *                     dalı `onRejected`'a HİÇ TAŞIMIYOR — bu bilinçli
 *                     (`ticket-workflow.ts`). Damga yok, yankı imkânsız.
 *   · `onDone`      — akışın sonu, bütün kapılar kapalı. Damga yok.
 *
 * Sonuç: BEŞ taşımanın DÖRDÜ, kapı damgası boşken yapılıyor. Zaman katmanı
 * (`gateOpenedSince`) onları teknik olarak imkânsız kılıyor — çünkü damga yoksa
 * `tryGateStatusDecision` daha ilk kontrolde `not_at_gate` diyerek çıkıyor.
 * Çakışma yasağı bu dördü için ÖLÇÜLEBİLİR HİÇBİR ŞEY korumuyordu; yalnızca
 * operatörün doğru yapılandırmasını reddediyordu.
 *
 * ── KALAN TEK RİSK: `onReview` ───────────────────────────────────────────
 * `onReview` taşıması damganın atılmasından HEMEN ÖNCE oluyor. Aynı iş
 * parçacığında, aynı sırada — yani mantıken yankı eşiğin gerisinde. Ama iki
 * ödün buna güvenmeyi kabul edilemez kılıyor:
 *
 *   1. Sıralama bir YARIŞA bağlı: Jira'nın webhook'u ile damganın Temporal'a
 *      yazılması arasındaki milisaniyeler. Yoklama yolunda changelog kaydının
 *      damgası kullanılıyor ve saat kaymaları (site saati vs. motor saati)
 *      onu eşiğin ÖNÜNE geçirebilir.
 *   2. Bedeli asimetrik: yanlış giderse kapı KENDİ AÇILIŞIYLA KENDİNİ
 *      KAPATIR — imzasız bir onay, SoD'nin (M32) engellemek için var olduğu
 *      şeyin ta kendisi.
 *
 * O yüzden `onReview` çakışması TEK BAŞINA yasak kalıyor, ve yasak dar: kapı
 * kararı `onReview`den okunamaz. Zaten okunmasına gerek de yok — kapı ORADA
 * açılıyor, yani "ticket kapının beklediği yerde" bir karar değil, kapının
 * kendi hâli.
 *
 * ── YENİ MODEL: BEŞ ALAN, ÇİFT YÖNLÜ ─────────────────────────────────────
 * `gateApproveStatus` / `gateReturnStatus` ARTIK ZORUNLU DEĞİL:
 *
 *   · onay statüsü      = `gateApproveStatus` ?? `onDone`
 *   · geri gönderme     = `gateReturnStatus`  ?? `onRejected` ?? `onStart`
 *
 * `onRejected` yoksa `onStart`a düşmesi, operatörün hattının kendisinden
 * geliyor: geri gönderme ticket'ı işin YAPILDIĞI yere (`analiz`) döndürür, ve
 * o yer `onStart`tır. `onRejected` boş bırakılmış bir kurulumda — ki Maestro
 * `return_analysis`te oraya zaten taşımıyor — hattın geri kenarı `onStart`
 * olur ve kanal çalışır. Yoksa operatör beş kutuyu doldurup kapının hâlâ
 * sağır olduğunu görürdü.
 *
 * ── GERİYE DÖNÜK UYUM ────────────────────────────────────────────────────
 * İki alan KALDIRILMADI, İSTEĞE BAĞLI hâle geldi. Dolu ise KAZANIR (operatör
 * onları bilerek yazmış olabilir ve hattından farklı bir statü seçmiş
 * olabilir); boş ise yeni geri düşüş devreye girer. Migration YOK — kolon
 * `statusMapJson`, JSON, ve şeması değişmedi.
 */
export function gateStatusesOf(map: StatusMap | null | undefined): GateStatuses {
  if (map == null) return { approve: null, return: null, conflicts: [] };
  const conflicts: string[] = [];

  /**
   * Bir adayı `onReview` çakışmasına karşı süz.
   *
   * `field` yalnız RAPOR için: geri düşüşle gelen bir değerin çakışması,
   * operatöre "yazdığın alan düştü" diye değil, "bu iki kutu aynı olamaz" diye
   * anlatılmalı.
   */
  const vet = (value: string | undefined, field: string): string | null => {
    if (value === undefined || value.trim() === "") return null;
    if (sameStatus(value, map.onReview)) {
      conflicts.push(`${field}=${value.trim()} ↔ onReview`);
      return null;
    }
    return value.trim();
  };

  // İki çağrı da yapılır, kısa devre YOK: biri çakışsa bile diğeri geçerli
  // olabilir, ve her iki çakışma da rapora girmeli.
  const approve = vet(
    map.gateApproveStatus ?? map.onDone,
    map.gateApproveStatus === undefined ? "onDone" : "gateApproveStatus",
  );
  const returned = vet(
    map.gateReturnStatus ?? map.onRejected ?? map.onStart,
    map.gateReturnStatus !== undefined
      ? "gateReturnStatus"
      : map.onRejected !== undefined
        ? "onRejected"
        : "onStart",
  );
  return { approve, return: returned, conflicts };
}

/**
 * Bir PROJENİN kurallarından kapı statülerini topla.
 *
 * ── Neden kurallar YENİDEN okunuyor, koşuya çivilenmiş eşleme kullanılmıyor ──
 * `statusMap`'in YAZMA tarafı koşu başlarken girdiye çivileniyor, ve gerekçesi
 * sağlam: bir admin öğlen kuralı düzenlerse sabahki ticket'ın nereye gittiği
 * değişmemeli, ve koşunun geçmişi bunu açıklayabilmeli.
 *
 * OKUMA tarafında bu gerekçe TERSİNE dönüyor. Kapı statüsü, operatörün ŞU AN
 * panosunda ne yaptığının anlamıdır. Bir operatör "onay statüsünü yanlış
 * yazmışım" deyip düzelttiğinde, o anda kapıda bekleyen ticket'ın düzeltmeyi
 * görmemesi — düzeltilmiş kuralın yalnız YENİ koşularda işlemesi — kapıda
 * bekleyen işi kurtarılamaz kılardı: koşu haftalarca beklerken kural doğru,
 * kapı sağır. Kural ne diyorsa o geçerlidir.
 *
 * Denetim izi bundan zarar görmez: kararı hangi statünün ürettiği
 * `decideGate`'in `reason` alanında yazılıdır.
 *
 * ── HER ŞEY KURAL BAZINDA, VE BU FONKSİYON BUNUN KANITI ──────────────────
 * Kapı noktaları `ListeningRuleRecord.statusMap`ten okunuyor — kuralın
 * KENDİSİNDEN. Global bir statü haritası, bir "kurulum varsayılanı" ya da
 * koda gömülü bir statü adı YOK ve olmamalı: bir bankada OTYT projesi
 * `analiz / analysisapproval / development` yürürken yanındaki proje
 * `İnceleme / Onay / Geliştirme` yürütebilir, ve ikisi aynı Maestro
 * kurulumunda yaşar. Aynı ilke `analystVariantId` / `engineerVariantId` /
 * `flowType` / `allowedStatuses` için de geçerli — hepsi aynı kayıtta.
 *
 * Geri düşüşler (`gateApproveStatus` yoksa `onDone`, …) bu ilkeyi BOZMAZ:
 * düşülen değer de aynı kuralın kendi haritasından geliyor, başka bir kuraldan
 * ya da bir varsayılandan değil.
 *
 * Birden çok kural eşleşirse hepsinin statüleri TOPLANIR. Bu bilinçli olarak
 * `flow-decision`'ın "en dar kural kazanır" kuralından FARKLI: orada soru
 * "hangi akış koşacak" (tek bir cevabı olmalı), burada "operatör bu hareketle
 * ne demek istedi" (bir statü, kuralların herhangi birinde tanımlıysa anlamı
 * vardır). İki kural aynı kararı farklı statülere bağlayabilir ("Geliştirme"
 * ve "Development" ikisi de onay) ve ikisi de geçerlidir.
 *
 * ── VE TOPLAMA, GERİ DÜŞÜŞLE BİRLİKTE DAHA SIK ÇAKIŞMA ÜRETEBİLİR ────────
 * Eskiden bir kuralın kapı noktası olması için operatörün o iki alanı AÇIKÇA
 * doldurması gerekiyordu; artık beş alanlı bir harita da noktalar üretiyor.
 * Yani aynı projede iki kural — biri `onDone: "Tamam"`, diğeri
 * `onStart: "Tamam"` — "Tamam"ı zıt kararlara bağlayabilir. Aşağıdaki
 * çelişki elemesi bunu zaten yakalıyor ve fail-closed düşürüyor; geri düşüş o
 * elemeyi atlamıyor, ona DAHA ÇOK iş veriyor, ve bu doğru olan: belirsiz bir
 * onay, olmayan bir onaydan tehlikelidir.
 */
export interface ProjectGateStatuses {
  /** Onay anlamına gelen statü adları, küçük harfe indirgenmiş. */
  approve: ReadonlySet<string>;
  /** Analize geri gönderme anlamına gelen statü adları, küçük harfe indirgenmiş. */
  return: ReadonlySet<string>;
  /** Düşürülen alanlar ve neyle çakıştıkları — çağıran bunu raporlamalı. */
  conflicts: readonly string[];
}

export function gateStatusesForRules(
  rules: readonly ListeningRuleRecord[],
  projectKey: string,
): ProjectGateStatuses {
  const conflicts: string[] = [];
  const approve = new Set<string>();
  const returned = new Set<string>();

  for (const rule of rules) {
    if (!rule.enabled || rule.projectKey !== projectKey) continue;
    const own = gateStatusesOf(rule.statusMap);
    for (const line of own.conflicts) conflicts.push(`${rule.ruleId}: ${line}`);
    // Kümeler de KATLANMIŞ adla anahtarlanıyor: `decideFromStatus` Jira'nın
    // yazdığı adı arayacak ve o ad operatörünkinden harf harf farklı olabilir.
    if (own.approve !== null) approve.add(foldStatusName(own.approve));
    if (own.return !== null) returned.add(foldStatusName(own.return));
  }

  // Aynı statü iki karara birden bağlanmış — iki AYRI kuralın çelişmesi.
  // `gateStatusesOf` bunu göremez (tek kurala bakar), ve yanlış tahminin bir
  // yönü "onaylanmadığı hâlde ilerlemek". İkisinden de düşer.
  for (const name of [...approve].filter((name) => returned.has(name))) {
    conflicts.push(`${name}: hem onay hem geri gönderme statüsü`);
    approve.delete(name);
    returned.delete(name);
  }

  return { approve, return: returned, conflicts };
}

/**
 * Ticket'ın statüsü hangi kararı ifade ediyor — `null` ise hiçbirini.
 *
 * Çakışan statüler `gateStatusesForRules` tarafından zaten düşürülmüş olduğu
 * için burada belirsizlik kalmaz: bir ad ya onaydır, ya geri göndermedir, ya
 * da kapıyla ilgisizdir.
 */
export function decideFromStatus(
  statuses: ProjectGateStatuses,
  status: string,
): "approve" | "return_analysis" | null {
  const wanted = foldStatusName(status);
  if (wanted === "") return null;
  if (statuses.approve.has(wanted)) return "approve";
  if (statuses.return.has(wanted)) return "return_analysis";
  return null;
}

/** Bir olayın/okumanın kapı kararı olup olmadığını sormak için gereken her şey. */
export interface GateStatusObservation {
  ticket: TicketKey;
  /** Ticket'ın ŞU ANKİ statü adı. */
  status: string;
  /**
   * Değişimi yapan hesap ve karşılaştırılacak bot kimliği — KİMLİK katmanı.
   *
   * Yoklama yolunda `actor` okunamaz; orada bu alan HİÇ verilmez ve katman
   * atlanır (`clarify-reentry.ts`'in yoklama tarafıyla aynı ödün, aynı
   * gerekçe: yön ve zaman katmanları taşır). Webhook yolunda verilir ve
   * `actor === undefined` olması "bot değildi" DEĞİL, "kanıtlayamıyoruz"
   * demektir — o durumda tetiklenmez.
   */
  identity?: { actor: string | undefined; bot: string };
  /** Olayın alındığı an — ZAMAN katmanı bununla ölçülür. */
  observedAt: Date;
  /**
   * Bu kanal ONAYI taşıyabilir mi.
   *
   * ── Neden bu bir seçenek, sabit bir "evet" değil ─────────────────────────
   * `decideGate` GRUP ÜYELİĞİ sorar (M32/M35): statü değiştirmek yetkiyi
   * atlamanın yolu değildir. Üyelik ancak kararı VERENİ adlandırabildiğimizde
   * ölçülebilir — yani `identity` olan kanalda (webhook).
   *
   * BUGÜN İKİ KANAL DA `true` GEÇİYOR, ve alan yine de var:
   *
   *   · Webhook kanalı aktörü teslimattan okuyor.
   *   · Yoklama kanalı Jira CHANGELOG'undan okuyor (`listStatusChanges`) —
   *     bu alan ilk yazıldığında yoklama yolu yalnız "ticket şu an nerede"yi
   *     biliyordu ve kimseyi adlandıramıyordu; onay o yüzden taşınamıyordu.
   *     Changelog eklendi, ödün ortadan kalktı.
   *
   * Alan KALDIRILMADI çünkü sildiği risk hâlâ duruyor: aktörü olmayan üçüncü
   * bir kanal (bir toplu iş, bir CSV içe aktarımı, bir yönetim aracı) her an
   * eklenebilir, ve `canApprove` olmadan o kanal SESSİZCE onay taşıyan bir
   * kanal olarak doğardı. İmzasız bir onay, SoD'nin (M32) engellemek için var
   * olduğu şeyin ta kendisi.
   *
   * Varsayılan YOK, ve bu bilinçli: her çağıran bu soruyu açıkça cevaplamak
   * zorunda.
   *
   * Not: `false` geçen bir kanal yine de GERİ GÖNDERMEYİ taşıyabilir, ve
   * asimetri bilerek — geri gönderme işi ilerletmez, analizi yeniden yazdırır
   * ve kapıyı yeniden açar. En kötü ihtimalle yetkisiz biri bir analiz turu
   * daha harcatır; kimse hiçbir şeyi onaylamış olmaz.
   */
  canApprove: boolean;
}

/**
 * Statü kanalıyla bir kapı kararı ver — webhook ve yoklama yollarının ORTAK yolu.
 *
 * Hiçbir yolda FIRLATMAZ. Webhook rotası Jira'ya 202 dönmek zorunda (5xx'i
 * Jira yeniden gönderir, M14), ve yoklama turu bir ticket yüzünden yarıda
 * kalmamalı.
 */
export async function tryGateStatusDecision(
  deps: ResolvedDeps,
  observation: GateStatusObservation,
  workflowId: string,
): Promise<GateStatusReentry> {
  if (observation.status.trim() === "") {
    return { kind: "skipped", reason: "not_issue_event" };
  }

  let state: WorkflowRunState | null;
  try {
    state = await deps.runs.queryRunState(workflowId);
  } catch {
    // Motor cevap vermedi. Webhook yolunda 202, yoklama yolunda bir sonraki
    // tur — ikisinde de "uygun değil" ile aynı davranış.
    return { kind: "skipped", reason: "not_at_gate" };
  }
  // Kapı açılış damgası, koşunun bir onay kapısında beklediğinin KENDİSİ:
  // `gate-loop.ts` onu `openGate`'ten sonra atıyor ve kapı kapanınca siliyor.
  // `status === "gate"` tek başına yetmezdi — 2b beklemesi de öyle raporlanır.
  if (state === null || state.gateOpenedSince === undefined) {
    return { kind: "skipped", reason: "not_at_gate" };
  }

  // ── katman 3: zaman ──────────────────────────────────────────────────────
  const threshold = Date.parse(state.gateOpenedSince);
  if (!Number.isFinite(threshold) || observation.observedAt.getTime() < threshold) {
    return { kind: "skipped", reason: "before_gate_opened" };
  }

  // ── katman 2: yön ────────────────────────────────────────────────────────
  if (deps.listening === undefined) return { kind: "skipped", reason: "no_gate_statuses" };
  let rules: readonly ListeningRuleRecord[];
  try {
    rules = await deps.listening.list();
  } catch {
    return { kind: "skipped", reason: "no_gate_statuses" };
  }
  const statuses = gateStatusesForRules(rules, projectKeyOf(observation.ticket));
  const verdict = decideFromStatus(statuses, observation.status);
  if (verdict === null) {
    /**
     * ── ÜÇ AYRI CEVAP, VE ÜÇÜ DE SESSİZ DEĞİL ──────────────────────────────
     *
     * Çakışma VAR ama karar yok = eşleme bozuk; çakışma yok ve karar yok =
     * kuralda tanımlı bir rolü olmayan bir statü hareketi; hiçbir nokta
     * yapılandırılmamış = kanal bu projede kapalı. Üçü ayrı raporlanır çünkü
     * operatörün yapması gereken üçünde farklı: eşlemeyi düzelt / bu statünün
     * bir rolü olsun mu diye karar ver / kanalı hiç açmamışsın.
     *
     * `known` İKİSİNE DE ekleniyor — kuralın hangi noktaları tanıdığı,
     * "hiçbir şey olmadı" cümlesini teşhisten talimata çeviren şey. Kanal hiç
     * yapılandırılmamışsa listelenecek bir şey de yok, o yüzden orada
     * eklenmiyor.
     */
    const known = {
      approve: [...statuses.approve],
      return: [...statuses.return],
    };
    if (statuses.conflicts.length > 0) {
      return { kind: "skipped", reason: "status_map_conflict", known, conflicts: statuses.conflicts };
    }
    const configured = statuses.approve.size > 0 || statuses.return.size > 0;
    return configured
      ? { kind: "skipped", reason: "not_a_gate_status", known }
      : { kind: "skipped", reason: "no_gate_statuses" };
  }

  /**
   * ONAYI TAŞIMAYAN KANALDA onay statüsü — bir hata değil, kanalın sınırı.
   *
   * Ayrı bir cevap olarak dönüyor ("sıradan bir statü hareketi" ile
   * karıştırılmıyor), çünkü tam olarak operatörün "onay statüsüne taşıdım,
   * hiçbir şey olmadı" sorusunun cevabı, ve çağıran ona ne yapması gerektiğini
   * söylemek zorunda: `/approve` yazmak.
   */
  if (verdict === "approve" && !observation.canApprove) {
    return { kind: "skipped", reason: "approval_needs_identity" };
  }

  // ── katman 1: kimlik ─────────────────────────────────────────────────────
  //
  // Yön katmanından SONRA, bilerek: sıradan bir statü hareketi (kapı statüsü
  // olmayan) bu kontrole hiç gelmez, yani "actor_unknown" sayacı yalnız
  // gerçekten karar üretecek olayları sayar ve okunabilir kalır.
  const identity = observation.identity;
  if (identity !== undefined) {
    const actor = identity.actor?.trim() ?? "";
    if (actor === "") return { kind: "skipped", reason: "actor_unknown" };
    if (actor.toLowerCase() === identity.bot.trim().toLowerCase()) {
      return { kind: "skipped", reason: "bot_echo" };
    }
  }

  const at = observation.observedAt.toISOString();
  /**
   * KARARI VEREN KİM — ve neden statü kanalında bu soru webhook ile yoklama
   * arasında farklı cevaplanıyor.
   *
   * Kapı kararı `decideGate`'ten geçer ve o GRUP ÜYELİĞİ sorar: statü
   * değiştirmek, yetki kontrolünü atlamanın yolu değildir. Webhook yolunda
   * `actor` bilindiği için gerçek kişi denetime yazılır ve üyeliği ölçülür.
   *
   * Yoklama yolunda kimse adlandırılamaz, ve orada bu fonksiyon `identity`
   * ALMAZ — çağıran (`jira-poller.ts`) kararı vermeden önce kimin taşıdığını
   * öğrenmek zorunda. Bu modül kimseyi uydurmaz.
   */
  const actorId = identity?.actor?.trim() ?? "";
  const result = await decideGate(deps, {
    ticket: observation.ticket,
    decision: verdict,
    actor: actorId,
    membershipId: actorId,
    source: "jira",
    at,
    reason: `Jira statüsü '${observation.status.trim()}' olarak değiştirildi`,
  });
  return {
    kind: "decided",
    ticket: observation.ticket,
    step: state.step,
    decision: verdict,
    result,
  };
}
