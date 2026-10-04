/**
 * `Variant` ve `VariantVersion` satırlarının şekli — okuyan ve YAZAN taraf
 * için tek kaynak.
 *
 * İki tanım bir dönem `read-variants.ts` ve `write-variants.ts` içinde birebir
 * kopya olarak duruyordu. Kopya, `stores` için bir barrel açılana kadar
 * görünmüyordu: iki dosya da kendi adını dışavuruyordu ve kimse ikisini yan
 * yana koymuyordu. Barrel koydu ve derleyici çakışmayı bildirdi.
 *
 * Kopyanın maliyeti burada tipik olanı: okuma tarafına bir sütun eklenirse
 * (diyelim `archivedAt`) yazma tarafı onu görmez ve iki taraf aynı tabloyu
 * farklı zanneder. Aynı satırın iki farklı tarifi olamaz.
 */

/** A `Variant` row. */
export interface VariantRow {
  id: string;
  role: string;
  name: string;
}

/** A `VariantVersion` row. */
export interface VariantVersionRow {
  variantId: string;
  version: number;
  model: string;
  configJson: unknown;
  evalScore: number | null;
  createdAt: Date;
}
