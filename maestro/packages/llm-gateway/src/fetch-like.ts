/**
 * Sürücülerin dayandığı dar `fetch` şekli — testleri çevrimdışı tutar.
 *
 * Kendi dosyasında, çünkü hem `http.ts` (isteği atan taraf) hem `tls.ts`
 * (sertifika doğrulamasına karar veren taraf) buna dayanıyor. Tanım bir dönem
 * `http.ts` içindeydi ve `tls.ts` onu oradan alıyordu; `http.ts` de `tls.ts`ten
 * `insecureFetch` aldığı için ortada bir döngü vardı.
 *
 * Döngü pratikte zararsızdı (iki modül birbirini yalnız fonksiyon gövdelerinden
 * çağırıyordu), ama yön yanlıştı: TLS kararı HTTP taşımasına bağımlı değildir,
 * ikisi de aynı çağrı imzasını paylaşır. Paylaşılan tek şey imzaydı, ve o artık
 * ikisinin de altında, hiçbir şeye bağlanmadan duruyor.
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
