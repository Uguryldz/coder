/**
 * DÖRT-GÖZ KURALININ GRUBU — tek kaynakta, bağımlılıksız.
 *
 * Sabit bir dönem `propose.ts` içindeydi. Oradan üç yönlü bir halka doğuyordu:
 * `master-approver` sabiti `propose`tan alıyor, `propose` `params-service`e
 * yazmak için ona bağlanıyor, `params-service` de yetkiyi sorabilmek için
 * `master-approver`a dönüyordu.
 *
 * Halkanın kendisi çalışma zamanında zararsızdı, ama yanlış şeyi söylüyordu:
 * "ikinci çift gözün hangi grupta olduğu" bir GÜVENLİK OLGUSUDUR ve onu
 * kullanan servislerin hiçbirine ait değildir. Öneri akışı yeniden yazılsa da
 * bu satır aynı kalır. Kendi dosyasında, hiçbir şeye bağlanmadan duruyor.
 */

/** The group that supplies the second pair of eyes on a guarded change (M71/M32). */
export const FOUR_EYES_GROUP = "maestro-admins";
