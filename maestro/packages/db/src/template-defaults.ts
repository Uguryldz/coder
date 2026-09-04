/**
 * The analysis template a fresh installation starts with (M108).
 *
 * Why a default exists at all: the designer screen reads the PUBLISHED
 * template, and before the first publish there is none — `GET /template`
 * answers 404 `no_template` and the screen renders nothing an operator can
 * act on. A platform whose first screen is empty teaches its first user that
 * the feature is unfinished. So the installer publishes version 1, exactly the
 * way it seeds the operational parameters, and the bank edits from there.
 *
 * WHAT THE ENGINE DOES WITH IT. The analyst runs the engine's fixed corporate
 * skeleton (`packages/agent-roles/data/analysis-template.tr.json`, nine
 * sections with schema/contract bindings). A Studio-published template is an
 * OVERLAY on that skeleton: it renames sections and rewrites their AI
 * instructions, never adds or removes one. Studio keys are slugs of the
 * Turkish titles and can never equal the engine's camelCase keys, so the
 * overlay is matched BY POSITION (`applyTemplateOverlay` in apps/pilot). That
 * is why this default has exactly the skeleton's nine sections IN ITS ORDER —
 * an operator who edits section 3 here edits the engine's impact matrix, as
 * the screen says.
 *
 * The wording follows the bank's own process-definition documents (the PDD
 * sample under plan/): a "Tanım" paragraph up front, planning and
 * prerequisites, applications in scope, a step-wise design, and a signed-off
 * risk/rollback section. The Word template under deploy/banka/sablon carries
 * the same nine slots, so the generated .docx reads like the bank's own file.
 *
 * What this is NOT: sample text. Every `aiInstruction` goes into the model's
 * prompt verbatim; every `example` is what the designer shows an operator as
 * the shape expected. Turkish because these strings are document CONTENT, not
 * UI chrome (M104).
 *
 * It is a STARTING POINT, not a policy: version 1 is append-only like every
 * other version (M83). Nothing re-seeds over it — see `seedAnalysisTemplate`.
 */

/** Mirrors `TemplateSection` in apps/bff/src/deps.ts — the wire shape. */
export interface DefaultTemplateSection {
  key: string;
  title: string;
  description: string;
  aiInstruction: string;
  required: boolean;
  format: "free_text" | "bullet_list" | "table" | "impact_matrix";
  example: string;
}

export const DEFAULT_ANALYSIS_TEMPLATE_NAME = "Kurumsal analiz şablonu (PDD düzeni) v1";

/**
 * The engine skeleton's keys, in order. Not imported from `@maestro/agent-roles`
 * (this package must not depend on it); `test/template-defaults.test.ts` pins
 * the count and the order against this list, and apps/pilot's own tests pin
 * the list against the engine JSON.
 */
export const ENGINE_SKELETON_KEYS: readonly string[] = [
  "purpose",
  "scope",
  "impactMatrix",
  "acceptanceCriteria",
  "uiApiChanges",
  "testApproach",
  "riskAndRollback",
  "sources",
  "openItems",
];

/**
 * Keys are the slugs `slugify()` derives from the titles, written out here so
 * this file is readable on its own. `test/template-defaults.test.ts` re-derives
 * them with the server's own function, so a title edited without its key is a
 * failing test rather than a template whose generated schema silently drops a
 * section. The `format` is the DESIGNER's view of the section; the engine keeps
 * its own binding (an impact matrix stays an impact matrix).
 */
export const DEFAULT_ANALYSIS_TEMPLATE_SECTIONS: readonly DefaultTemplateSection[] = [
  {
    // engine: purpose (free_text)
    key: "amac_ve_is_degeri",
    title: "Amaç ve iş değeri",
    description:
      "Sürecin/değişikliğin TANIMI ve neden yapıldığı; iş sonucu cinsinden ölçülebilir fayda. " +
      "Planlama (ne zaman, hangi sıklıkta) ve otomasyon için asgari ön koşullar da burada.",
    aiInstruction:
      "Ticket'ı ve bildiren yanıtlarını oku. Önce \"Tanım\" başlığı altında süreci ya da değişikliği 2-4 cümlede " +
      "İŞ diliyle anlat (hangi süreç, kim için, hangi uygulamada); teknik terim kullanma. Ardından ölçülebilir " +
      "bir fayda cümlesi yaz (hedef oran, süre ya da adet) — ticket'ta yoksa uydurma, \"ölçüt belirtilmemiş\" yaz. " +
      "Sonra \"Planlama\" satırında ne zaman/hangi sıklıkta çalışacağını, \"Ön koşullar\" satırında gereken " +
      "erişim ve yetkileri (ekran/rapor/uygulama adıyla) tek tek yaz. Teknik çözümü BURADA anlatma.",
    required: true,
    format: "free_text",
    example:
      "Tanım: Bu süreç, BOA uygulamasında geciken kredi ödemelerini, vadesi yaklaşan teminat mektuplarını ve " +
      "taksitleri takip edip ilgili ekiplere bilgilendirme e-postası gönderir.\n" +
      "Fayda: Günlük yaklaşık 2 saatlik manuel takip kalkar; bilgilendirme aynı gün 08:30'da tamamlanır.\n" +
      "Planlama: Günde 1 kez, sabah 08:30.\n" +
      "Ön koşullar: BOA erişimi; \"İdari Takip Müşteri Raporu\" ve \"Teminat Mektubu İşlemleri\" ekranlarına yetki.",
  },
  {
    // engine: scope (list_group — dahil / hariç)
    key: "kapsam_dahil_haric",
    title: "Kapsam (dahil / hariç)",
    description:
      "Bu işin sınırı: neye dokunuluyor, neye dokunulmuyor. Süreçte kullanılan uygulamalar ve dijital " +
      "girdi/çıktılar dahil listesinde adıyla geçer; hariç listesi kapsam kadar önemlidir.",
    aiInstruction:
      "İki liste üret: DAHİL ve HARİÇ. Dahil listesine sürecin alt adımlarını, kullanılan her uygulamayı " +
      "(ör. BOA, Outlook) ve dijital girdi/çıktıları (hangi rapor girdi, hangi e-posta/dosya çıktı) ayrı " +
      "maddeler olarak yaz. Hariç listesini boş bırakma — kapsam dışı bıraktığın her şeyi tek tek yaz, çünkü " +
      "ürün sahibinin onayladığı sınır budur. Bir şeyin kapsamda olup olmadığını bilmiyorsan hariç listesine " +
      "\"netleşmedi\" notuyla yaz ve açık maddelere taşı.",
    required: true,
    format: "bullet_list",
    example:
      "DAHİL: BOA \"İdari Takip Müşteri Raporu\" ekranından Excel çıktısı alınması\n" +
      "DAHİL: Her satır için tekil bilgilendirme e-postası (Outlook)\n" +
      "HARİÇ: Bireysel müşteri segmenti\n" +
      "HARİÇ: E-postaya yanıtların takibi",
  },
  {
    // engine: impactMatrix (impact_matrix)
    key: "etki_analizi",
    title: "Etki analizi",
    description:
      "Hangi uygulama etkileniyor, hangisi etkilenmiyor — her uygulama için karar ve kaynağı. Alt " +
      "ticket'lar bu tablodan açılır.",
    aiInstruction:
      "Repo keşfi çıktısını ve Uygulama Kayıtları'nı kullan. Her uygulama için etkilenip etkilenmediğine " +
      "KARAR VER; etkilenmiyorsa da satır aç ve gerekçesini yaz. \"Belki\" yazma. Etkilenen uygulama için " +
      "özet alanında etkinin türünü (kod, veri, entegrasyon, yapılandırma) ve büyüklüğünü belirt. Kaynak " +
      "alanına repo keşfinden gelen dosya yolunu ya da uygulama kartını yaz; depoda karşılığını " +
      "göremediğin bir bileşeni \"doğrulanmadı\" notuyla ekle, sessizce atlama.",
    required: true,
    format: "impact_matrix",
    example:
      "ugurpay-core · evet · kod, orta: limit kontrolü burada uygulanacak · src/limit/service.ts\n" +
      "ugurmobil-ios · hayır · limit ekranı API sözleşmesi değişmiyor · apps/ios/README.md",
  },
  {
    // engine: acceptanceCriteria (bullet_list, en az 3)
    key: "kabul_kriterleri",
    title: "Kabul kriterleri",
    description:
      "Değişikliğin doğru çalıştığını kanıtlayan, tek tek doğrulanabilir maddeler (en az üç); test " +
      "senaryoları buradan türer.",
    aiInstruction:
      "Her madde tek bir doğrulanabilir davranış olsun ve bir testle karşılanabilsin: \"verildiğinde / " +
      "yapıldığında / beklenen\" biçiminde yaz. En az bir olumsuz senaryo (hatalı ya da eksik girdi) ve en az " +
      "bir sınır durumu ekle; geriye uyum maddesini unutma. \"Sistem düzgün çalışmalı\" gibi ölçülemez ifade " +
      "kullanma.",
    required: true,
    format: "bullet_list",
    example:
      "Raporda \"İzleme Durumu = İhtarname Çekildi\" olan satır için e-posta üretilmez.\n" +
      "Rapor boş döndüğünde süreç hatasız biter ve \"işlem yok\" özeti gönderilir.\n" +
      "Mevcut günlük bilgilendirme akışı değişmeden çalışmaya devam eder.",
  },
  {
    // engine: uiApiChanges (table: Yüzey · Durum · Geriye uyum) — isteğe bağlı
    key: "ekran_ve_api_degisiklikleri",
    title: "Ekran ve API değişiklikleri",
    description:
      "Kullanıcıya ve entegrasyona görünen yüzey: hangi ekran ya da uç nokta yeni, hangisi değişti, " +
      "geriye uyumlu mu. Yüzeye dokunulmuyorsa boş kalır.",
    aiInstruction:
      "UI'ye veya API'ye dokunulmuyorsa bu bölümü hiç doldurma. Dokunuluyorsa her ekran ve uç nokta için bir " +
      "satır: yüzey (ekran adı ya da metot + yol), durum (yeni / değişti / değişmedi) ve geriye uyumlu olup " +
      "olmadığı. Eski istemcinin kırılacağı bir değişiklik varsa \"geriye uyumlu değil\" yaz ve nedenini " +
      "yüzey adının yanına ekle.",
    required: false,
    format: "table",
    example:
      "Kredi limiti ekranı · değişti · evet\n" +
      "POST /limit/artir · yeni · —",
  },
  {
    // engine: testApproach (free_text)
    key: "test_yaklasimi",
    title: "Test yaklaşımı",
    description:
      "Birim / entegrasyon / uçtan uca dağılımı, kapsam eşiği ve test verisi ihtiyacı. Test tasarımcısının " +
      "girdisidir.",
    aiInstruction:
      "Test piramidine uy. Birim, entegrasyon ve uçtan uca testlerin yaklaşık adedini ve kapsam eşiğini yaz. " +
      "Kabul kriterlerinin her birinin hangi seviyede doğrulanacağını belirt. Gerçek müşteri verisi " +
      "gerekiyorsa maskelenmiş/anonim test verisi kullanılacağını açıkça yaz. Bu bölüm test tasarımcısının " +
      "girdisi olur — ona göre somut yaz.",
    required: true,
    format: "free_text",
    example:
      "Birim: filtreleme ve e-posta gövdesi üretimi (~12 test). Entegrasyon: BOA rapor çıktısının okunması " +
      "(anonim örnek dosyayla, ~4 test). Uçtan uca: 1 senaryo, test ortamında. Kapsam eşiği %80.",
  },
  {
    // engine: riskAndRollback (field_group: risk · mitigation · rollback)
    key: "risk_ve_geri_donus_plani",
    title: "Risk ve geri dönüş planı",
    description:
      "Ne ters gidebilir, nasıl azaltılır, nasıl geri alınır. Önlemsiz risk kabul edilmiş risktir ve öyle " +
      "yazılır; denetim bu bölüme bakar.",
    aiInstruction:
      "En az bir gerçek risk yaz (etkisiyle birlikte), azaltma önlemini ve GERİ DÖNÜŞ adımını ayrı ayrı " +
      "belirt. Teknik riskin yanında operasyonel riski de değerlendir (yanlış müşteriye bildirim, çağrı " +
      "merkezi yükü). Şema ya da veri göçü, gönderilmiş bildirim gibi geri alınamayan bir adım varsa bunu " +
      "açıkça yaz; özellik bayrağıyla kapatılabiliyorsa bayrağın adını ver. Önlemi olmayan riski silme, " +
      "\"önlem yok — kabul edilen risk\" yazarak onaycıya bırak.",
    required: true,
    format: "free_text",
    example:
      "Risk: Filtre hatası yüzünden ihtarname çekilmiş müşteriye hatırlatma gider (itibar, orta).\n" +
      "Azaltma: Gönderim öncesi \"İzleme Durumu\" için ikinci kontrol; ilk hafta gönderim listesi elle onaylanır.\n" +
      "Geri dönüş: Zamanlanmış görev durdurulur; gönderilmiş e-postalar geri alınamaz, düzeltme e-postası şablonu hazır tutulur.",
  },
  {
    // engine: sources (source_list)
    key: "kaynaklar",
    title: "Kaynaklar",
    description:
      "Her iddianın dayanağı: repo dosyası, uygulama kartı, öğrenme notu ya da ticket cümlesi. Kaynağı " +
      "olmayan iddia yazılmaz.",
    aiInstruction:
      "Yazdığın HER bölüm için en az bir kaynak satırı aç: hangi bölüm, hangi kaynak. Kaynak, sana verilen " +
      "bağlamda birebir geçen bir değer olmalı — repo dosya yolu, uygulama kartındaki alan, öğrenme notunun " +
      "başlığı ya da ticket'taki cümle. Kaynak gösteremiyorsan iddiayı hiç yazma; uydurma kesinlikle yasak.",
    required: true,
    format: "bullet_list",
    example:
      "Amaç ve iş değeri ← ticket açıklaması, 1. paragraf\n" +
      "Etki analizi ← src/limit/service.ts; Uygulama Kayıtları: ugurpay-core",
  },
  {
    // engine: openItems (open_items)
    key: "netlestirilecek_acik_maddeler",
    title: "Netleştirilecek açık maddeler",
    description:
      "Cevaplanmamış ya da ertelenmiş maddeler: madde, neden açık, kimden cevap bekleniyor. Onaycı neyin " +
      "açık kaldığını burada görür.",
    aiInstruction:
      "Cevap alamadığın veya ertelenen her maddeyi yaz: madde, neden açık kaldığı ve kimden (rol ya da kişi) " +
      "cevap beklendiği. Gerçekten açık madde yoksa listeyi boş bırak — ama \"bilmiyorum\" dediğin bir konuyu " +
      "buraya yazmadan analizi teslim etme.",
    required: true,
    format: "bullet_list",
    example:
      "Bireysel segmentin kapsam dışı kalması teyit edilmedi — ürün sahibinden yanıt bekleniyor.\n" +
      "E-posta gönderim saati 08:30 mu 09:00 mı — süreç sahibinden yanıt bekleniyor.",
  },
];
