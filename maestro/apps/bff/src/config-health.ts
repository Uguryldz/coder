/**
 * YAPILANDIRMA TEŞHİSİ — "bu kurulum NASIL kurulmuş" sorusunun tek ekranlık
 * cevabı.
 *
 * ── NEDEN AYRI BİR UÇ (ve ayrı bir dosya) ───────────────────────────────────
 * `/studio/health` bir CANLILIK sorusudur: Postgres ayakta mı, Temporal cevap
 * veriyor mu. Her satırı bir probe'un o anki sonucudur, 60 saniyede bir
 * yenilenir ve cevabı zamanla DEĞİŞİR.
 *
 * Buradaki satırların hiçbiri öyle değil. "Jira sürücüsü jira-dc" bir ölçüm
 * değil bir KURULUM GERÇEĞİdir: `.env`'de hangi değişkenin dolu olduğuyla
 * belirlenir, servis yeniden başlayana kadar değişmez, ve yanlışsa çözümü bir
 * probe'u tekrar denemek değil bir dosyayı düzeltmektir. İkisini tek yanıta
 * karıştırmak iki şeyi bozardı:
 *
 *  · canlılık yanıtının `state` toplayıcısı ("en kötü servis kazanır")
 *    yapılandırma bulgularını da yutardı — yapılandırılmamış bir Jira, kapalı
 *    bir Postgres ile aynı kırmızıyı üretirdi, oysa biri çağrı merkezi
 *    vakasıdır diğeri bir `.env` satırı;
 *  · bu uç veritabanına da bakıyor (varyant model denetimi, dinleme
 *    kurallarının statü eşlemeleri) ve o okumaların maliyeti canlılık
 *    yoklamasının 60 saniyelik döngüsüne ait değil.
 *
 * Bu yüzden `GET /studio/config-health` ayrı bir uçtur, kendi `state`'iyle.
 * `/studio/health` yanıtı BİR HARF DEĞİŞMEDİ — mevcut ekran, mevcut testler ve
 * mevcut alarm kuralları olduğu gibi çalışmaya devam ediyor.
 *
 * ── SIR SIZDIRMAMA SÖZLEŞMESİ ───────────────────────────────────────────────
 * Bu dosyadan çıkan hiçbir alan bir DEĞER taşımaz: ne URL, ne jeton, ne parola,
 * ne e-posta, ne hesap kimliği. Yalnızca (a) değişken ADLARI, (b) "tanımlı /
 * tanımsız" gibi kapalı durumlar, (c) sürücü/varyant kimlikleri gibi zaten
 * genel olan adlar geçer. Sebep `listening-banner.ts`'nin sebebiyle aynı: bir
 * Jira taban adresi `https://kullanici:parola@jira...` biçiminde userinfo
 * taşıyabilir, ve panel yanıtı tarayıcı geçmişine, ekran görüntüsüne ve destek
 * ticket'ına giden bir eserdir.
 */

/**
 * Bir satırın ağırlığı. `sorun` en üstte, `iyi` en altta sıralanır — ekran bu
 * alana göre sıralar, sırayı kendi yeniden hesaplamaz.
 */
export type ConfigSeverity = "sorun" | "uyari" | "iyi" | "bilgi";

/** Yapılandırma teşhisinin tek satırı. */
export interface ConfigFinding {
  /**
   * Satırın kimliği — ekran bunu `config.row.<id>` katalog anahtarına çevirir.
   * Kararlı: bir kurulumdan diğerine, bir sürümden diğerine aynı kalır.
   */
  readonly id: string;
  readonly severity: ConfigSeverity;
  /**
   * Satırın DEĞERİ, tek kelimelik kapalı bir durum olarak (`jira-dc`,
   * `acik`, `KAPALI`). Asla bir sır, asla serbest metin.
   */
  readonly value: string;
  /**
   * Değeri açıklayan katalog anahtarı, ya da null. Ekran çevirir; sunucu
   * cümle yazmaz — `health.note.not_configured` deseninin aynısı.
   */
  readonly detailKey: string | null;
  /** `detailKey` cümlesine gömülecek parametreler (hepsi sırsız). */
  readonly detailParams?: Readonly<Record<string, string>>;
  /**
   * Sorunun ÇÖZÜMÜ, katalog anahtarı olarak. `iyi` satırlarda null: yeşil bir
   * satırın yanında bir "şunu yapın" cümlesi, düzeltilecek bir şey varmış gibi
   * okunur.
   */
  readonly fixKey: string | null;
  readonly fixParams?: Readonly<Record<string, string>>;
}

export interface ConfigHealthResponse {
  /**
   * Bulguların en kötüsü. `/studio/health`'in `state`'inden AYRI, çünkü ayrı
   * bir soruyu cevaplıyor: "bu kurulum doğru mu kurulmuş", "şu an ayakta mı"
   * değil.
   */
  readonly state: ConfigSeverity;
  readonly findings: readonly ConfigFinding[];
}

/**
 * Kompozisyon kökünün (apps/deploy) BİLDİĞİ, bu paketin bilemeyeceği gerçekler.
 *
 * `WorkPort` bir sürücü kimliği taşımaz ve `@maestro/bff` `apps/deploy`'u import
 * EDEMEZ (bağımlılık ters yönde). Bu yüzden aynı desen: kök bir okuyucu enjekte
 * eder, uç onu okur. `commandIntakeStatus` ve `discoveryStatus` zaten böyle
 * çalışıyor — bu üçüncüsü.
 *
 * Bir fonksiyon, bir değer değil: cevap servis ömrü boyunca sabit olsa bile
 * (sürücü kimliği), `deps` kurulurken sürücü henüz kurulmamış olabilir; aynı
 * geç-bağlama `discoveryRun`'ın kutusuyla birebir aynı sebeple gerekli.
 */
export type DeploymentConfigReader = () => DeploymentConfigFacts;

export interface DeploymentConfigFacts {
  /** İş sürücüsünün kayıt defterindeki kimliği: `jira-dc`, `jira-cloud`, `not-configured`. */
  readonly workDriver: string;
  /**
   * Sürücüyü SEÇEN ortam değişkeninin adı (`JIRA_BASE_URL` /
   * `JIRA_CLOUD_BASE_URL`), ya da hiçbiri doluysa null. DEĞERİ değil ADI.
   */
  readonly workDriverVariable: string | null;
  /**
   * Adres, seçilen sürücünün ait olduğu Jira çeşidine BENZİYOR mu.
   *
   * `null` = soru anlamsız (hiç adres yok, ya da ikisi birden dolu). `false` =
   * çelişki: Cloud sürücüsü seçilmiş ama adres `*.atlassian.net` değil (yani
   * bir Data Center adresi Cloud satırına yazılmış), ya da tersi.
   *
   * KARAR BURADA VERİLMEZ, yalnız TAŞINIR: heuristik `apps/deploy`'daki
   * `jiraUrlLooksLikeCloud`ta, yani URL'in gerçekten görüldüğü yerde çalışır ve
   * buraya tek bir `boolean` olarak gelir. Bu bilerek: adres bu pakete hiç
   * girmezse, bu paketin hiçbir yanıtından sızamaz.
   */
  readonly cloudUrlLooksLikeCloud: boolean | null;
  /** Ticket taraması gerçekten çalışıyor mu (zamanlayıcı kuruldu mu). */
  readonly sweepEnabled: boolean;
  /** Tarama periyodu, saniye. Kapalıyken 0. */
  readonly sweepSeconds: number;
  /** Periyodun kaynağı: kimse yazmadıysa `varsayilan`, `.env`'den geldiyse `env`. */
  readonly sweepSource: "varsayilan" | "env";
  /** Tarama kapalıysa NEDEN — kapalı bir küme, serbest metin değil. */
  readonly sweepOffReason: "kapatildi" | "surucu-arama-sunmuyor" | null;
  /** Webhook imzasının doğrulanacağı sırrın REFERANSI tanımlı mı (değeri değil). */
  readonly webhookSecretConfigured: boolean;
  /** İş sürücüsü ticket'ı statüden statüye taşıyabiliyor mu (`transitionToStatus`). */
  readonly canMoveStatus: boolean;
}

/**
 * Netleştirme dönüşünün durumu — `apps/deploy/src/listening-banner.ts`
 * içindeki `ClarifyReentryStatus`'un aynısı, ama bu paket oradan import
 * edemeyeceği için burada da yazılı. İki tanımın ayrışmaması, kökün bu tipe
 * ATANMASIYLA derleme zamanında garanti altında.
 */
export type ClarifyReentryState =
  | { readonly state: "open"; readonly source: "env" | "connection" }
  | { readonly state: "closed"; readonly reason: "no_bot_account" | "no_ticket_reader" };

/** Yorum yoklamasının durumu — `GET /studio/command-intake`'in okuduğu şeyin aynısı. */
export interface CommandIntakeFacts {
  readonly mode: "webhook" | "poll" | "both";
  readonly pollSeconds: number;
  readonly canReadComments: boolean;
  readonly source: "param" | "env" | "default";
}

/** Varyant model denetiminin bu ekrana yansıyan kadarı. */
export interface VariantModelFacts {
  readonly scanned: number;
  /** Erişilemez bulut modeli taşıyan varyantların ADLARI — model adı taşınmaz. */
  readonly cloudModelVariants: readonly string[];
}

/** Dinleme kurallarının statü eşlemesi tarafı. */
export interface StatusMapFacts {
  readonly ruleCount: number;
  /** Statü eşlemesi DOLU olan kural sayısı. */
  readonly mappedRuleCount: number;
}

/**
 * Dinleme kurallarının taşıdığı BOT KİMLİĞİ, bağlantının bildiğiyle
 * karşılaştırıldığında.
 *
 * Kural, bot hesabının bir KOPYASINI taşır (`assigneeAccountId`) çünkü tarama o
 * değeri doğrudan JQL'e yapıştırır. Kopya ayrışabilir, ve bir kez ayrıştı: DC
 * yoklaması kullanıcı adı (`name`, "ugyildiz") yerine iç tutamağı (`key`,
 * "jirauser13506") okuyordu. JQL `assignee`yi kullanıcı adıyla çözdüğü için her
 * tarama boş döndü — ve Jira buna hata değil 200 + boş sayfa cevabı verdiği
 * için hiçbir ekran nedenini söylemiyordu. Bu satır tam olarak o sessizliği
 * kapatıyor: kimse bir düğmeye basmasa bile arıza EKRANDA yazar.
 *
 * Sayılar taşınır, kimliklerin KENDİSİ değil. Bir Jira hesap kimliği sır
 * sayılmaz, ama bu yanıtın sözleşmesi kapalı değerler ve sayılardır
 * (dosyanın başındaki sır sızdırmama maddesi); operatörün hangi değerin yanlış
 * olduğunu görmesi gereken yer, düzeltmenin yapıldığı Dinleme kuralları
 * ekranıdır.
 */
export interface RuleIdentityFacts {
  /** Toplam kural sayısı — sıfırsa sorulacak bir şey yok. */
  readonly ruleCount: number;
  /** Bağlantının bildiği kimliği taşımayan kural sayısı. */
  readonly staleRuleCount: number;
  /** Kaç ayrı eskimiş kimlik var (bir mi, birkaç mı). */
  readonly staleAccountCount: number;
  /**
   * DC iç tutamağı desenine (`jirauser<sayı>`) benzeyen kimlik taşıyan kural
   * sayısı — bağlantıyla kıyastan BAĞIMSIZ. Bağlantı hiç test edilmemişse ya da
   * o da aynı yanlış değeri taşıyorsa, desen tek kalan işarettir.
   */
  readonly internalKeyRuleCount: number;
  /** Bağlantı testi bir kimlik öğrenmiş mi — kıyas mümkün mü. */
  readonly connectionKnown: boolean;
}

export interface ConfigHealthInput {
  readonly deployment: DeploymentConfigFacts | null;
  readonly intake: CommandIntakeFacts | null;
  readonly clarify: ClarifyReentryState | null;
  readonly variants: VariantModelFacts | null;
  readonly statusMaps: StatusMapFacts | null;
  readonly ruleIdentity: RuleIdentityFacts | null;
}

/** Ağırlık sırası — `sorun` en üstte. */
const SEVERITY_ORDER: Readonly<Record<ConfigSeverity, number>> = {
  sorun: 0,
  uyari: 1,
  bilgi: 2,
  iyi: 3,
};

/**
 * Gerçeklerden satırları üret — SAF. Ağın, veritabanının ve saatin dışında,
 * çünkü bu dosyanın değeri tam olarak burada: "DC'de webhook yokluğu bir hata
 * DEĞİLDİR" gibi kuralların birim testi olabilmesi.
 */
export function buildConfigFindings(input: ConfigHealthInput): readonly ConfigFinding[] {
  const findings: ConfigFinding[] = [
    ...workDriverFindings(input.deployment),
    ...sweepFindings(input.deployment),
    ...intakeFindings(input.intake),
    ...clarifyFindings(input.clarify),
    ...webhookFindings(input.deployment),
    ...variantFindings(input.variants),
    ...statusMapFindings(input.statusMaps, input.deployment),
    ...ruleIdentityFindings(input.ruleIdentity),
  ];
  // Kararlı sıralama: önce ağırlık, sonra üretim sırası. `sort` yerinde ve
  // kararlı olduğu için eşit ağırlıklı satırlar yukarıdaki mantıksal sırayı
  // korur — sürücü satırı, taşıdığı ağırlık ne olursa olsun, kendi grubunun
  // başında kalır.
  return [...findings].sort(
    (left, right) => SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity],
  );
}

/** Bulguların en kötüsü — yanıtın tek kelimelik özeti. */
export function worstSeverity(findings: readonly ConfigFinding[]): ConfigSeverity {
  if (findings.some((finding) => finding.severity === "sorun")) return "sorun";
  if (findings.some((finding) => finding.severity === "uyari")) return "uyari";
  if (findings.some((finding) => finding.severity === "bilgi")) return "bilgi";
  return "iyi";
}

/**
 * EN ÖNEMLİ SATIR: hangi Jira.
 *
 * `apps/deploy/src/profile.ts:workDriverFor` ile aynı cevap — kök onu çağırıp
 * sonucunu buraya verir, burada yeniden karar verilmez. Ekranda en üste
 * çıkması için `iyi` durumda bile listenin başında üretilir.
 */
function workDriverFindings(facts: DeploymentConfigFacts | null): ConfigFinding[] {
  if (facts === null) return [unreported("jira_driver")];
  if (facts.workDriverVariable === null) {
    return [
      {
        id: "jira_driver",
        severity: "sorun",
        value: "yapilandirilmamis",
        detailKey: "config.detail.jira_driver.none",
        fixKey: "config.fix.jira_driver.none",
      },
    ];
  }
  /**
   * ADRES SÜRÜCÜYE BENZEMİYOR — bu satırın var olma sebebi.
   *
   * Sürücü satırı kendi başına yeşildi ve doğruydu: "Cloud, çünkü
   * JIRA_CLOUD_BASE_URL dolu" cümlesi bir bankada saatler yaktığı gün de
   * DOĞRUYDU. Eksik olan, o değişkenin İÇİNDEKİ adresin bir Cloud adresi
   * olmadığıydı — bir Data Center adresi yanlış satıra yazılmıştı, sistem
   * Cloud sürücüsüyle (`/rest/api/3`, `Basic`) DC'ye gidiyordu ve hiçbir
   * ekran bunu göremiyordu.
   *
   * `uyari`, `sorun` değil: bir kurum Cloud'un önüne kendi vekilini koyabilir
   * ve o durumda Cloud sürücüsü DOĞRU seçimdir. Yanılabilen bir işaret
   * kırmızıya boyanırsa operatör kırmızıyı yok saymayı öğrenir — bu ekranın
   * en pahalıya patlayacak kaybı o olurdu.
   *
   * `null` sessizce geçilir: soru anlamsızsa (adres yok, ya da ikisi birden
   * dolu) uydurulmuş bir cevap vermek "bilmiyoruz"dan kötüdür.
   */
  if (facts.cloudUrlLooksLikeCloud === false) {
    const cloud = facts.workDriverVariable === "JIRA_CLOUD_BASE_URL";
    return [
      {
        id: "jira_driver",
        severity: "uyari",
        value: facts.workDriver,
        detailKey: cloud
          ? "config.detail.jira_driver.url_not_cloud"
          : "config.detail.jira_driver.url_is_cloud",
        // Yine yalnız ADLAR. Adresin kendisi bu pakete hiç girmedi: buraya
        // gelen tek şey bir boolean.
        detailParams: { variable: facts.workDriverVariable },
        fixKey: cloud
          ? "config.fix.jira_driver.url_not_cloud"
          : "config.fix.jira_driver.url_is_cloud",
      },
    ];
  }
  return [
    {
      id: "jira_driver",
      severity: "iyi",
      value: facts.workDriver,
      detailKey: "config.detail.jira_driver.chosen",
      // Yalnızca değişkenin ADI. Adresin kendisi bilerek yok.
      detailParams: { variable: facts.workDriverVariable },
      fixKey: null,
    },
  ];
}

/** Ticket taraması: açık mı, kaç saniyede bir, kim söyledi. */
function sweepFindings(facts: DeploymentConfigFacts | null): ConfigFinding[] {
  if (facts === null) return [unreported("sweep")];
  if (facts.sweepEnabled) {
    return [
      {
        id: "sweep",
        severity: "iyi",
        value: "acik",
        detailKey:
          facts.sweepSource === "varsayilan"
            ? "config.detail.sweep.on_default"
            : "config.detail.sweep.on_env",
        detailParams: { seconds: String(facts.sweepSeconds) },
        fixKey: null,
      },
    ];
  }
  /**
   * Kapalılığın iki ayrı sebebi var ve iki ayrı yere gönderiyorlar: biri
   * `.env`'deki bir satır, diğeri sürücünün yeteneği. `bin/bff.ts` bu ayrımı
   * zaten yapıyor (`sweepReason`), burada aynı ayrım korunuyor.
   */
  const bySetting = facts.sweepOffReason !== "surucu-arama-sunmuyor";
  return [
    {
      id: "sweep",
      severity: "uyari",
      value: "KAPALI",
      detailKey: bySetting ? "config.detail.sweep.off_setting" : "config.detail.sweep.off_driver",
      fixKey: bySetting ? "config.fix.sweep.off_setting" : "config.fix.sweep.off_driver",
    },
  ];
}

/** Yorum yoklaması: `/approve` ticket'tan nasıl okunuyor. */
function intakeFindings(intake: CommandIntakeFacts | null): ConfigFinding[] {
  if (intake === null) return [unreported("intake")];
  if (!intake.canReadComments) {
    /**
     * Sürücü yorum okuyamıyor. Bu, yoklamanın "kapalı" olmasından farklı ve
     * daha ağır: ticket'a yazılan `/approve` HİÇBİR ayarla okunamaz, kapıların
     * tek yolu panel kalır. `listening-banner.ts`'nin ilk uyarısıyla aynı olay.
     */
    return [
      {
        id: "intake",
        severity: "sorun",
        value: "okunamiyor",
        detailKey: "config.detail.intake.no_reader",
        fixKey: "config.fix.intake.no_reader",
      },
    ];
  }
  if (intake.mode === "webhook") {
    return [
      {
        id: "intake",
        severity: "uyari",
        value: "yalniz-webhook",
        detailKey: "config.detail.intake.webhook_only",
        fixKey: "config.fix.intake.webhook_only",
        detailParams: { source: sourceValue(intake.source) },
      },
    ];
  }
  return [
    {
      id: "intake",
      severity: "iyi",
      value: intake.mode === "both" ? "webhook+yoklama" : "yoklama",
      detailKey: "config.detail.intake.polling",
      detailParams: {
        seconds: String(intake.pollSeconds),
        source: sourceValue(intake.source),
      },
      fixKey: null,
    },
  ];
}

/** Netleştirme dönüşü — sessiz kapalılığın panele çıkan hâli. */
function clarifyFindings(clarify: ClarifyReentryState | null): ConfigFinding[] {
  if (clarify === null) return [unreported("clarify")];
  if (clarify.state === "open") {
    return [
      {
        id: "clarify",
        severity: "iyi",
        value: "acik",
        detailKey:
          clarify.source === "env"
            ? "config.detail.clarify.open_env"
            : "config.detail.clarify.open_connection",
        fixKey: null,
      },
    ];
  }
  /**
   * Bot kimliğinin yokluğu SORUN: koşu 2b'de sonsuza dek bekler ve hiçbir
   * yerde hata görünmez. Ticket okuyucusunun yokluğu ise yalnız yoklama
   * kanalını kapatır — webhook yolu (`clarify-reentry.ts`) ticket okuyucusuna
   * ihtiyaç duymaz — bu yüzden uyarı.
   */
  const noIdentity = clarify.reason === "no_bot_account";
  return [
    {
      id: "clarify",
      severity: noIdentity ? "sorun" : "uyari",
      value: "KAPALI",
      detailKey: noIdentity
        ? "config.detail.clarify.no_bot_account"
        : "config.detail.clarify.no_ticket_reader",
      fixKey: noIdentity
        ? "config.fix.clarify.no_bot_account"
        : "config.fix.clarify.no_ticket_reader",
    },
  ];
}

/**
 * Webhook — ve bu ekranın en kolay yanlış yapılabilecek satırı.
 *
 * Kapalı ağdaki bir Data Center kurulumunda Jira'nın bu adrese ÇIKMASI
 * mümkün değildir; webhook'suz çalışmak orada bir eksiklik değil TASARIMDIR ve
 * tarama+yoklama o kurulumun normal yoludur. Bu yüzden webhook sırrının
 * tanımsızlığı, tarama ya da yoklama açıkken bir HATA değil bir BİLGİdir.
 * Kırmızıya boyamak, operatöre düzeltilecek olmayan bir şeyi düzelttirmeye
 * çalışırdı — ve bu ekranın kırmızısına olan güveni bitirirdi.
 */
function webhookFindings(facts: DeploymentConfigFacts | null): ConfigFinding[] {
  if (facts === null) return [unreported("webhook")];
  if (facts.webhookSecretConfigured) {
    return [
      {
        id: "webhook",
        severity: "iyi",
        value: "tanimli",
        detailKey: "config.detail.webhook.configured",
        fixKey: null,
      },
    ];
  }
  return [
    {
      id: "webhook",
      severity: "bilgi",
      value: "tanimsiz",
      detailKey: "config.detail.webhook.absent",
      fixKey: "config.fix.webhook.absent",
    },
  ];
}

/**
 * Ajan modelleri — `packages/db/src/variant-model-audit.ts:auditVariantModels`
 * sonucunun panele çıkan hâli. Denetim burada YENİDEN YAZILMADI; kök onu
 * çağırıp bulgu adlarını buraya verir, `./ajan-modelleri.sh` ile aynı cevabı
 * veren tek bir mantık kalır.
 *
 * Varyant ADLARI taşınır, MODEL adları değil: model adı operatörün yazdığı
 * serbest bir metindir ve bu yanıtın sözleşmesi kapalı değerlerdir.
 */
function variantFindings(variants: VariantModelFacts | null): ConfigFinding[] {
  if (variants === null) return [unreported("variant_models")];
  if (variants.cloudModelVariants.length === 0) {
    return [
      {
        id: "variant_models",
        severity: "iyi",
        value: "temiz",
        detailKey: "config.detail.variant_models.clean",
        detailParams: { count: String(variants.scanned) },
        fixKey: null,
      },
    ];
  }
  return [
    {
      id: "variant_models",
      severity: "sorun",
      value: String(variants.cloudModelVariants.length),
      detailKey: "config.detail.variant_models.cloud",
      detailParams: { variants: variants.cloudModelVariants.join(", ") },
      fixKey: "config.fix.variant_models.cloud",
    },
  ];
}

/**
 * Statü haritası — iki ayrı gerçeğin tek satırı: sürücü ticket'ı taşıyabiliyor
 * mu (`transitionToStatus`, DC'de M111'den beri var), ve kurallarda eşleme
 * yazılmış mı.
 *
 * Eşlemenin boş olması bir HATA DEĞİLDİR: yorum-yalnız kip ürünün varsayılanı
 * ve pek çok kurulumun bilinçli tercihi. Sürücünün taşıyamaması da öyle — ama
 * eşleme YAZILMIŞ ve sürücü taşıyamıyorsa o bir çelişkidir, ve sessizce hiç
 * kıpırdamayan ticket'lar olarak görünür.
 */
function statusMapFindings(
  maps: StatusMapFacts | null,
  facts: DeploymentConfigFacts | null,
): ConfigFinding[] {
  if (maps === null || facts === null) return [unreported("status_map")];
  if (maps.mappedRuleCount > 0 && !facts.canMoveStatus) {
    return [
      {
        id: "status_map",
        severity: "sorun",
        value: "surucu-tasiyamiyor",
        detailKey: "config.detail.status_map.unsupported",
        detailParams: { mapped: String(maps.mappedRuleCount) },
        fixKey: "config.fix.status_map.unsupported",
      },
    ];
  }
  if (maps.mappedRuleCount === 0) {
    return [
      {
        id: "status_map",
        severity: "bilgi",
        value: "yorum-yalniz",
        detailKey: "config.detail.status_map.comment_only",
        detailParams: { rules: String(maps.ruleCount) },
        fixKey: "config.fix.status_map.comment_only",
      },
    ];
  }
  return [
    {
      id: "status_map",
      severity: "iyi",
      value: "acik",
      detailKey: "config.detail.status_map.mapped",
      detailParams: { mapped: String(maps.mappedRuleCount), rules: String(maps.ruleCount) },
      fixKey: null,
    },
  ];
}

/**
 * KURALLARIN BOT KİMLİĞİ — bu ekranın en pahalıya patlamış satırı.
 *
 * ── ÖLÇÜLEN ARIZA ───────────────────────────────────────────────────────────
 * Data Center `/myself` cevabında bir kullanıcıyı iki alanla adlandırır: `name`
 * ("ugyildiz", operatörün gördüğü kullanıcı adı) ve `key` ("jirauser13506", iç
 * tutamak). Bağlantı yoklaması `key`i okuyordu, o değer dinleme kurallarının
 * `assigneeAccountId` alanına tohumlandı, ve tarama onu doğrudan JQL'e
 * yapıştırıyor. JQL `assignee`yi KULLANICI ADIYLA çözer — iç tutamakla yazılan
 * sorgu hiçbir şeyle eşleşmez, ve Jira buna hata değil 200 + BOŞ sayfa cevabı
 * verir.
 *
 * Yani atanmış ticket'larla dolu bir projede her tur "0 sonuç" diyordu, her
 * ekran yeşildi, ve hiçbir yerde nedeni yazmıyordu. Bu satırın var olma sebebi
 * tam olarak bu: aynı arıza başka bir kurulumda tekrar ederse, kimse bir
 * düğmeye basmadan EKRANDA yazsın.
 *
 * ── İKİ AYRI İŞARET, İKİ AYRI AĞIRLIK ───────────────────────────────────────
 * 1. FARK (`staleRuleCount`) — kurallar bağlantının bildiği kimlikten BAŞKA bir
 *    değer taşıyor. Bu bir tahmin değil bir karşılaştırma: bağlantı testi
 *    Jira'dan canlı olarak öğrendi, kural başka bir şey diyor. `sorun`, çünkü
 *    tarama bu hâlde sessizce hiçbir ticket bulmuyor.
 * 2. DESEN (`internalKeyRuleCount`) — kurallardaki kimlik `jirauser<sayı>`
 *    biçiminde. `uyari`, `sorun` değil: desen bir TAHMİN, ve bazı DC
 *    kurulumlarında `key` gerçekten kullanıcı adına eşittir — orada
 *    düzeltilecek bir şey yok. Yanılabilen bir işareti kırmızıya boyamak,
 *    operatöre kırmızıyı yok saymayı öğretir; bu ekranın verebileceği en pahalı
 *    kayıp odur.
 *
 * Farkın önceliği var: ikisi birden doğruysa fark gösterilir, çünkü o kesin
 * olan ve düzeltmesi de aynı düğme.
 *
 * ── NEDEN BAĞLANTI BİLİNMEDEN DE BİR SATIR VAR ──────────────────────────────
 * Bağlantı hiç test edilmemişse kıyas yapılamaz — ama desen hâlâ okunabilir, ve
 * o durumda desen TEK kalan işarettir. "Bilmiyoruz" diye susmak, arızanın en
 * olası hâlinde ekranı sessiz bırakırdı.
 */
function ruleIdentityFindings(facts: RuleIdentityFacts | null): ConfigFinding[] {
  if (facts === null) return [unreported("rule_identity")];

  // Hiç kural yok: ayrışacak bir kopya da yok. `status_map` satırının kural
  // sayısını zaten söylediği yerde ikinci bir "kural yok" satırı gürültüdür.
  if (facts.ruleCount === 0) {
    return [
      {
        id: "rule_identity",
        severity: "bilgi",
        value: "kural-yok",
        detailKey: "config.detail.rule_identity.no_rules",
        fixKey: null,
      },
    ];
  }

  if (facts.staleRuleCount > 0) {
    return [
      {
        id: "rule_identity",
        severity: "sorun",
        value: "ayrisik",
        detailKey: "config.detail.rule_identity.stale",
        detailParams: {
          stale: String(facts.staleRuleCount),
          rules: String(facts.ruleCount),
          accounts: String(facts.staleAccountCount),
        },
        fixKey: "config.fix.rule_identity.stale",
      },
    ];
  }

  if (facts.internalKeyRuleCount > 0) {
    return [
      {
        id: "rule_identity",
        severity: "uyari",
        value: "ic-kimlik",
        detailKey: "config.detail.rule_identity.internal_key",
        detailParams: {
          affected: String(facts.internalKeyRuleCount),
          rules: String(facts.ruleCount),
        },
        fixKey: "config.fix.rule_identity.internal_key",
      },
    ];
  }

  /**
   * Kıyas yapılamadı ve desen de temiz. Yeşil DEĞİL: bağlantı test edilmemişken
   * "kimlikler uyumlu" demek, yapılmamış bir karşılaştırmanın sonucunu
   * bildirmek olurdu.
   */
  if (!facts.connectionKnown) {
    return [
      {
        id: "rule_identity",
        severity: "bilgi",
        value: "kiyaslanamadi",
        detailKey: "config.detail.rule_identity.no_connection",
        detailParams: { rules: String(facts.ruleCount) },
        fixKey: "config.fix.rule_identity.no_connection",
      },
    ];
  }

  return [
    {
      id: "rule_identity",
      severity: "iyi",
      value: "uyumlu",
      detailKey: "config.detail.rule_identity.aligned",
      detailParams: { rules: String(facts.ruleCount) },
      fixKey: null,
    },
  ];
}

/**
 * Bildirilmemiş bir gerçek.
 *
 * "Bilmiyoruz" ile "iyi" arasındaki farkı korumak bu ekranın bütün değeri:
 * kablolanmamış bir kurulumda yeşil bir satır göstermek, tam olarak bu ekranın
 * kapatmak için var olduğu sessiz-yanlış sınıfıdır. `bilgi` ağırlığıyla
 * çıkıyor — alarm değil, ama görünür.
 */
function unreported(id: string): ConfigFinding {
  return {
    id,
    severity: "bilgi",
    value: "bilinmiyor",
    detailKey: "config.detail.unreported",
    fixKey: null,
  };
}

/** Kaynağın operatörün diline çevrilmiş, sırsız hâli. */
function sourceValue(source: CommandIntakeFacts["source"]): string {
  if (source === "param") return "panel";
  if (source === "env") return "JIRA_POLL_MS";
  return "varsayilan";
}

/**
 * Panelden indirilen tanı raporunu ÜRETEN seam.
 *
 * ── NEDEN BİR SEAM, BİR FONKSİYON DEĞİL ─────────────────────────────────────
 * Sayfanın kendisi `apps/deploy/src/tani.ts`de üretiliyor (`taniHtml`) ve orada
 * kalmalı: sır maskelemesi, gürültü filtresi ve HTML kaçışı orada yazılı ve
 * orada test edilmiş. `@maestro/bff` `@maestro/deploy`u import EDEMEZ
 * (bağımlılık ters yönde), o yüzden kök enjekte eder, uç çağırır — `work`,
 * `runs` ve `commandIntakeStatus` ile birebir aynı sözleşme.
 *
 * ── UI RAPORU, BETİK RAPORUNUN ALT KÜMESİDİR ────────────────────────────────
 * Ve bu bir eksiklik değil bir SINIR: `./tani.sh` docker log'larını HOST'tan
 * topluyor (`docker compose logs`). BFF bir konteynerin İÇİNDE çalışıyor ve
 * kardeş konteynerlerin log'una erişemez — docker soketi bağlı değil, ve
 * bağlanmamalı da: panele erişebilen bir saldırgan, docker soketi üzerinden
 * host'un tamamını ele geçirir. Yani "servis log'ları yok" bir hata değil,
 * bilinçli bir güvenlik kararının sonucudur.
 *
 * BFF'in KENDİ log'u da alınamıyor, ve sebebi ayrı: Fastify'ın pino'su
 * `server.ts:138`de yalnız bir seviye ile kuruluyor, yani satırlar doğrudan
 * stdout'a yazılıyor — dosya yok, tablo yok, halka tampon yok. Süreç içinden
 * geriye okunacak bir yer yok. Bunu eklemek (bir halka tampon + sızıntı
 * denetimi) bu turun işi değil; eksikliğin RAPORUN İÇİNDE adıyla söylenmesi
 * ise şart, çünkü yarım bir rapora bakıp "sorun yok" demek tam olarak bu
 * ekranın kapatmaya geldiği hata.
 */
export type TaniReportBuilder = () => Promise<TaniReport>;

export interface TaniReport {
  /** Bitmiş, kendi kendine yeten HTML sayfası. */
  readonly html: string;
  /** İndirilecek dosyanın adı — `maestro-tani-YYYYAAGG-SSDD.html`. */
  readonly fileName: string;
}
