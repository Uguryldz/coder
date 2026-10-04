import type { TicketKey } from "@maestro/contracts";
import type { ActivityDeps, RunContext } from "./deps.js";
import { record } from "./record.js";

/**
 * ÇALIŞMA ALANI, KODA DOKUNAN HER ADIMIN ÖN KOŞULUDUR.
 *
 * Bu, ölçülmüş bir arızanın karşılığı. Koşu satırı bir `workspacePath` ve bir
 * `workspacePresent: true` taşır; ikisi de koşu AÇILIRKEN yazılır ve o andan
 * sonra diske hiç bakılmaz. Servis yeniden başlarsa (sürüm yükseltmesi, çökme,
 * bir `docker compose down -v`) dizin gider, satır aynı kalır.
 *
 * Bayrak tek yönlüdür: kod tabanında `workspacePresent: false` yazan TEK BİR
 * yer yoktur — ölçüldü. Yani "var" der ve bir daha asla "yok" diyemez. Kalıcı
 * bir sütun, geçici bir diskin gerçeğini taşıyamaz; taşıdığını sanmak arızanın
 * kendisiydi.
 *
 * Bir dönem yalnız 3ö keşif adımı kendini korurdu (`analysis.ts`). Kalan üç
 * adım ham yolu okuyordu ve sonuçları şunlardı:
 *
 *  - MÜHENDİSLİK: ajan var olmayan bir dizinde açılır, "dosya yok" der ve
 *    koşu kod üretmeden ilerler.
 *  - DOĞRULAYICI: aynısı, üstelik "doğrulandı" diyerek.
 *  - GÜVENLİK TARAMASI: en ağırı. Tarayıcılar boş bir dizini tarar, hiçbir
 *    bulgu üretmez ve akış `SECURITY_SCAN_PASS` yazar. Yani tarama, HİÇ
 *    BAKMADAN yeşil verir. Bir bankada bunun adı yanlış negatiftir ve
 *    taramanın var olma sebebini ortadan kaldırır.
 *
 * Bu modül tek bir soruyu yanıtlar: "bu adım kodu okumadan önce çalışma alanı
 * gerçekten yerinde mi, değilse var edilebilir mi". Yanıt yalnız yola bakarak
 * değil, sürücüye SORARAK verilir.
 */

export interface EnsuredWorkspace {
  /** Adımın KULLANMASI gereken yol — koşu satırındaki eski yol değil. */
  readonly path: string;
  /** Sürücü çalışma alanını var etti mi; `false` ise yol yalnız satırdan geliyor. */
  readonly ensured: boolean;
}

/**
 * Çalışma alanını var eder ve adımın kullanacağı yolu döner.
 *
 * Yol değiştiyse koşu satırı yamanır — sonraki adımlar eski yolu okumasın.
 * Yeniden klonlama SESSİZ DEĞİLDİR: deftere yazılır, çünkü "analizim neden bu
 * kadar sürdü" ve "klon neden iki kez açıldı" sorularının cevabı burasıdır.
 *
 * Sürücü bu yeteneği sunmuyorsa (klonlamayan bir kurulum) satırdaki yol
 * olduğu gibi döner ve `ensured: false` olur — çağıran eski davranışa düşer.
 */
export async function ensureWorkspaceFor(
  deps: ActivityDeps,
  run: RunContext,
  ticket: TicketKey,
  appId: string,
  step: string,
): Promise<EnsuredWorkspace> {
  const ensure = deps.scm.ensureWorkspace?.bind(deps.scm);
  if (ensure === undefined) return { path: run.workspacePath, ensured: false };
  try {
    const path = await ensure({
      runId: run.runId,
      appId,
      ...(run.targetBranch === undefined || run.targetBranch === null
        ? {}
        : { targetBranch: run.targetBranch }),
    });
    if (path === null) return { path: run.workspacePath, ensured: false };
    if (path !== run.workspacePath) {
      await deps.runs.patch(ticket, { workspacePath: path });
      await record(deps, run, {
        kind: "discovery",
        actor: "system",
        title: "çalışma alanı yeniden açıldı",
        detail: `${appId} klonu diskte yoktu (servis yeniden başlayınca çalışma alanı silinebilir) — ${step} adımından önce yeniden klonlandı.`,
        key: `discovery:reclone:${step}`,
      });
    }
    return { path, ensured: true };
  } catch (error) {
    await record(deps, run, {
      kind: "discovery",
      actor: "system",
      title: "çalışma alanı açılamadı",
      detail: `${appId} yeniden klonlanamadı: ${String(error)} — ${step} adımı kod karşılığı olmadan sürüyor.`,
      key: `discovery:reclone-failed:${step}`,
    });
    return { path: run.workspacePath, ensured: false };
  }
}

/**
 * GÜVENLİK TARAMASI İÇİN: çalışma alanı gerçekten var mı.
 *
 * Buradaki cevap `ensureWorkspaceFor`dan farklı bir şey için kullanılır ve
 * farklı bir sıkılıkta olmalıdır. Bir analiz adımı çalışma alanı olmadan
 * "kod karşılığı olmadan sürüyor" diyerek devam EDEBİLİR — çıktı eksiktir ama
 * yanıltıcı değildir, ve deftere öyle yazılır.
 *
 * Tarama devam EDEMEZ. Boş bir dizinde hiçbir tarayıcı bulgu üretmez, ve
 * bulgusuzluk bu akışta "temiz" diye okunur. Yani taramanın devam etmesi,
 * bakılmamış bir kod tabanına "güvenli" damgası vurmak demektir. Fail-closed
 * olması gereken yer tam olarak burasıdır (M20 ile aynı mantık: yanlış
 * tarafta yanılmak veri sızdırır).
 */
export function workspaceUsable(path: string): boolean {
  return path.trim() !== "";
}
