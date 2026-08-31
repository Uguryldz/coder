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
 *  2. **Yön** — hedef statü, kuralın `gateApproveStatus`/`gateReturnStatus`
 *     alanlarından BİRİ olmalı. Maestro'nun kendi taşıdığı statüler
 *     (`onStart`/`onNeedInfo`/`onReview`/`onRejected`/`onDone`) bu ikisiyle
 *     aynı olamaz — {@link gateStatusesOf} bunu ADLANDIRIR ve çakışan bir
 *     eşlemede kanal KAPANIR. Yön katmanının bu kanaldaki hâli budur ve
 *     netleştirmedeki "ticket bot'a döndü" kadar keskindir: operatörün
 *     Maestro'nun asla kendiliğinden taşımayacağı bir statüye taşıması.
 *  3. **Zaman** (`gateOpenedSince`) — olay, kapı AÇILDIKTAN sonra alınmış
 *     olmalı. Damga `openGate`'ten sonra atılıyor (`gate-loop.ts`), dolayısıyla
 *     `onReview` taşımasının ve kapı yorumunun yankısı eşiğin gerisinde kalır.
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
  | { kind: "skipped"; reason: GateStatusSkipReason };

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
   * Eşleme ÇAKIŞIK: kapı statüsü, Maestro'nun kendi taşıdığı bir statüyle aynı.
   * Kanal bu kural için KAPALI — bkz. {@link gateStatusesOf}.
   */
  | "status_map_conflict"
  /** Ticket'ın yeni statüsü ne onay ne geri gönderme statüsü — sıradan bir hareket. */
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
 * Kuralın kapı statüleri, ÇAKIŞMA ELENDİKTEN sonra.
 *
 * `null` alanlar "bu kural bu kararı statüyle kabul etmiyor" demek — ya hiç
 * yapılandırılmamış, ya da çakıştığı için düşürülmüş.
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
 * BİR KURALIN KAPI STATÜLERİ, ÇAKIŞMA KONTROLÜYLE.
 *
 * ── Neden çakışma kontrolü var ────────────────────────────────────────────
 * Eşlemenin iki yönü aynı belgede duruyor: beş alan Maestro'nun ticket'ı
 * NEREYE taşıdığını, iki alan operatörün taşımasının NE ANLAMA geldiğini
 * söylüyor. Operatör aynı statü adını iki yöne birden yazarsa — örneğin
 * `onRejected: "Analiz"` ve `gateReturnStatus: "Analiz"` — Maestro'nun kendi
 * taşıması, kendi kararı olarak geri okunurdu.
 *
 * Zaman katmanı (`gateOpenedSince`) bunu çoğu durumda yakalar: Maestro kendi
 * taşımasını kapı KAPANDIKTAN sonra yapar ve damga o an temizlenir. Ama buna
 * güvenmek, korumayı bir yarış koşusunun sonucuna bağlamak olurdu — ve bu
 * yanlış giderse bedeli kendi kendini onaylayan bir kapıdır.
 *
 * ── Neden 400 değil, sessiz düşürme değil, ADLANDIRILMIŞ düşürme ──────────
 * Yazma anında 400 vermek düşünüldü ve reddedildi: eşlemeyi kabul eden İKİ
 * yüzey var (dinleme kuralı ekranı ve kurulum sihirbazı), ve elle SQL'le
 * yazılmış bir satır ikisinden de geçmez. Okuma tarafı kendini korumak
 * zorunda. Sessizce düşürmek ise operatörün yazdığı bir ayarın hiç
 * çalışmaması demek olurdu — 0024'ün "çalışır ama GÖRÜNÜR" dersinin tersi.
 *
 * Seçilen: alan DÜŞER (fail-closed, kanal o karar için kapanır) ve çakışma
 * ADLANDIRILIR — `conflicts` çağırana döner, panel ve `config-health` okur.
 */
export function gateStatusesOf(map: StatusMap | null | undefined): GateStatuses {
  if (map == null) return { approve: null, return: null, conflicts: [] };
  const conflicts: string[] = [];
  /** Maestro'nun KENDİ taşıdığı noktalar — bunlarla çakışan bir kapı statüsü düşer. */
  const written: readonly (readonly [string, string | undefined])[] = [
    ["onStart", map.onStart],
    ["onNeedInfo", map.onNeedInfo],
    ["onReview", map.onReview],
    ["onRejected", map.onRejected],
    ["onDone", map.onDone],
  ];

  const keep = (field: "gateApproveStatus" | "gateReturnStatus"): string | null => {
    const value = map[field];
    if (value === undefined || value.trim() === "") return null;
    const clash = written.find(([, target]) => sameStatus(value, target));
    if (clash !== undefined) {
      conflicts.push(`${field}=${value.trim()} ↔ ${clash[0]}`);
      return null;
    }
    return value.trim();
  };

  // İki çağrı da yapılır, kısa devre YOK: biri çakışsa bile diğeri geçerli
  // olabilir, ve her iki çakışma da rapora girmeli.
  const approve = keep("gateApproveStatus");
  const returned = keep("gateReturnStatus");
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
 * Birden çok kural eşleşirse hepsinin statüleri TOPLANIR. Bu bilinçli olarak
 * `flow-decision`'ın "en dar kural kazanır" kuralından FARKLI: orada soru
 * "hangi akış koşacak" (tek bir cevabı olmalı), burada "operatör bu hareketle
 * ne demek istedi" (bir statü, kuralların herhangi birinde tanımlıysa anlamı
 * vardır). İki kural aynı kararı farklı statülere bağlayabilir ("Geliştirme"
 * ve "Development" ikisi de onay) ve ikisi de geçerlidir.
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
    // Çakışma VAR ama karar yok = eşleme bozuk; çakışma yok ve karar yok =
    // sıradan bir statü hareketi. İkisi ayrı raporlanır: birincisi operatörün
    // düzeltmesi gereken bir şey, ikincisi gürültü. Hiçbir kapı statüsü hiç
    // yapılandırılmamışsa bu kanal bu projede kapalıdır, ve o da ayrı bir
    // cevap — "yanlış yazılmış" ile "hiç istenmemiş" karıştırılmamalı.
    if (statuses.conflicts.length > 0) return { kind: "skipped", reason: "status_map_conflict" };
    const configured = statuses.approve.size > 0 || statuses.return.size > 0;
    return { kind: "skipped", reason: configured ? "not_a_gate_status" : "no_gate_statuses" };
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
