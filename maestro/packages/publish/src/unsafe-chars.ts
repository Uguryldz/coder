/**
 * Yayımlanan hiçbir belgenin taşıyamayacağı karakterler — TEK YERDE.
 *
 * Bu dosya, `md.ts` ile `parse.ts` arasındaki döngüyü kaldırmak için açıldı.
 * Döngü kâğıt üzerindeydi ve pratikte zararsızdı (iki modül birbirini yalnız
 * fonksiyon gövdelerinden çağırıyordu, modül başlatma anında değil); yine de
 * yanlış yöndeydi: OKUYAN taraf (`parse.ts`) YAZAN tarafa (`md.ts`) bağımlı
 * hale geliyordu, oysa aralarındaki tek ortak şey bir güvenlik süzgeciydi.
 * Süzgeç artık ikisinin de altında duruyor ve hiçbir yöne bağımlı değil.
 *
 * Neden bu karakterler:
 *
 * 1. `U+0000-08, 0B, 0C, 0E-1F` XML 1.0'da her biçimde yasaktır — CDATA
 *    dahil. Analiz metni model çıktısıdır ve günlükleri, test koşularını
 *    alıntılar; yani bir NUL ya da bir ANSI renk kodu (ESC[31m) renderer'a
 *    olağan biçimde ulaşır. Confluence buna kalıcı olarak 400 döner ve tek bir
 *    hedefin düşmesi tüm yayımı düşürdüğü için jira ve repo-docs de onunla
 *    birlikte ölür.
 *
 * 2. Bidi ve görünmez kontrol karakterleri (`U+202E` ve akrabaları) metnin
 *    baytlarını değiştirmeden GÖRÜNEN sırasını ters çevirir: imzalı bir onay
 *    kapısında "RİSK DÜŞÜK" tersten okutulabilir. Bu yüzden kaçırılmaz,
 *    DÜŞÜRÜLÜR — bu hattaki hiçbir meşru belgenin bunlara ihtiyacı yok.
 */
const FORBIDDEN_CHARS = new RegExp(
  "[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F" + // illegal in XML 1.0, CDATA included
    "\\u200B-\\u200F\\u202A-\\u202E\\u2066-\\u2069\\uFEFF]", // bidi / invisible
  "g",
);

export function stripUnsafeChars(text: string): string {
  return text.replace(FORBIDDEN_CHARS, "");
}
