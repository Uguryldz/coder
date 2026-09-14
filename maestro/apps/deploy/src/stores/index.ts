/**
 * KALICI KATMANIN PAYLAŞILAN YÜZEYİ.
 *
 * `apps/demo-stack` bu depolara ihtiyaç duyuyor: prova yığını GERÇEK Postgres
 * deposuyla koşuyor, sahte bir bellek deposuyla değil — aksi hâlde provada
 * geçen bir şey sahada düşebilirdi ve provanın değeri kalmazdı.
 *
 * Erişim bir dönem `../../../deploy/src/stores/users.js` biçiminde YİRMİ ayrı
 * göreli yolla yapılıyordu ve `demo-stack/package.json` `@maestro/deploy`ı
 * bağımlılık olarak HİÇ bildirmiyordu. İki ayrı sorun:
 *
 *  1. Bildirilmemiş bağımlılık: paket yöneticisi bu kenarı görmez, yani
 *     sıralama, önbellek ve "bu paket nelere dokunur" sorusunun cevabı yanlış.
 *  2. Dosya sistemi yolu bir SÖZLEŞME değildir: `stores/` içinde bir dosya
 *     yeniden adlandırıldığında kırılan yer başka bir uygulamadır ve bunu
 *     hiçbir şey hatırlatmaz.
 *
 * Buradan dışavurulanlar artık bilinçli bir yüzeydir. `stores/` altındaki 53
 * dosyanın tamamı DEĞİL — yalnız prova yığınının gerçekten kullandıkları.
 * Listeye eklemek bir karardır, göreli bir yol yazmak değildi.
 */
export * from "./app-registry-writer.js";
export * from "./audit.js";
export * from "./bindings.js";
export * from "./connections.js";
export * from "./doc-template.js";
export * from "./encrypted-secret.js";
export * from "./guidance.js";
export * from "./killswitch.js";
export * from "./listening.js";
export * from "./params-store.js";
export * from "./read-governance.js";
export * from "./read-health.js";
export * from "./read-live.js";
export * from "./read-variants.js";
export * from "./routing.js";
export * from "./sessions.js";
export * from "./sql.js";
export * from "./template.js";
export * from "./users.js";
export * from "./write-variants.js";
