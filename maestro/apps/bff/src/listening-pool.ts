import type { FlowType } from "@maestro/contracts";

/**
 * "Maestro'nun havuzunda hiçbir zaman ticket kalamaz; işlem yapıldıktan sonra
 * ileri ya da geri oynar." — operatörün kuralı, kural kaydında doğrulanır.
 *
 * Havuz = kuralın `allowedStatuses` seçmiş olması (robot yalnız o durumdaki
 * ticket'ları alır). Havuzlu bir kuralın iki ÇIKIŞI olmalı:
 *  · GERİ: bilgi eksikse ticket havuzdan çıkar — `onNeedInfo` durumu ya da
 *    `reassignOnNeedInfo` (talep sahibine atama; bot atamasından çıkmak da
 *    havuzdan çıkmaktır, çünkü tarama `assignee = bot` arar).
 *  · İLERİ: iş bitince ticket havuzdan çıkar — kapılı analiz akışında
 *    `onReview`, kapısız (`gateSteps: []`) ya da düzeltme akışında `onDone`.
 *    `onDone` her hâlde kabul: kapıya girmeden biten koşu oraya gider.
 *
 * Eksikler ADLANDIRILIR (`missing`): hata metni operatöre hangi alanın boş
 * olduğunu söyler. Statü seçmeyen (atamayla çalışan) kural havuz değildir;
 * bu kural onu ilgilendirmez.
 */
export interface PoolExitRule {
  readonly allowedStatuses: readonly string[] | null | undefined;
  readonly statusMap:
    | {
        readonly onNeedInfo?: string;
        readonly onReview?: string;
        readonly onDone?: string;
        readonly reassignOnNeedInfo?: boolean;
      }
    | null
    | undefined;
  readonly flowType: FlowType | string;
  /**
   * Kapı dizisi: `{ steps: [] }` ya da `[]` = bilerek kapısız; `null`/`undefined`
   * = varsayılan kapı dizisi (kapılı). İki şekil de kabul: kayıt `{steps}` taşır,
   * teşhis tarafı düz liste verebilir.
   */
  readonly gateSteps?: { readonly steps: readonly string[] } | readonly string[] | null;
}

function gateless(gateSteps: PoolExitRule["gateSteps"]): boolean {
  if (gateSteps == null) return false;
  const steps: readonly string[] = "steps" in gateSteps ? gateSteps.steps : gateSteps;
  return steps.length === 0;
}

export type PoolExitGap = "statusMap" | "onNeedInfo" | "onReview" | "onDone";

export function poolExitGaps(rule: PoolExitRule): PoolExitGap[] {
  const pooled = Array.isArray(rule.allowedStatuses) && rule.allowedStatuses.length > 0;
  if (!pooled) return [];
  const map = rule.statusMap;
  if (map == null) return ["statusMap"];
  const filled = (value: string | undefined): boolean => typeof value === "string" && value.trim() !== "";
  const gaps: PoolExitGap[] = [];
  if (!filled(map.onNeedInfo) && map.reassignOnNeedInfo !== true) gaps.push("onNeedInfo");
  const gated = rule.flowType !== "duzeltme" && !gateless(rule.gateSteps);
  const forward = gated ? filled(map.onReview) || filled(map.onDone) : filled(map.onDone);
  if (!forward) gaps.push(gated ? "onReview" : "onDone");
  return gaps;
}
