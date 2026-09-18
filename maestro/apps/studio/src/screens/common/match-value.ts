/**
 * Bir tetikleme değerinin İKİ hâli — okunan AD ve kaydedilen DEĞER — ve
 * aralarındaki tek kural. Dinleme kuralı formu ile kurulum sihirbazı aynı
 * kuralı paylaşır; iki kopya bir dönem ayrıştı ve sihirbaz takım yönetimli
 * projede adı kaydederken form kimliği kaydediyordu.
 *
 * Takım yönetimli ("next-gen", `simplified: true`) bir Jira projesinde JQL,
 * konu türünü ve statüyü YALNIZ id ile eşler. Hata da vermez, boş döner. Canlı
 * ölçüm (proje OPS, aynı ticket kümesi):
 *
 *   issuetype = "Görev"         ->  0 ticket      issuetype = 10008 -> 14
 *   status in ("Yapılacaklar")  ->  0 ticket      status = 10004    -> 12
 *
 * Yani böyle bir projede ADLA kaydedilen kural sonsuza dek hiçbir ticket
 * bulmaz ve panelde "kural arandı, 0 ticket" yazar. Bu yüzden proje takım
 * yönetimliyse kaydedilen değer id'dir; şirket yönetimliyse bugüne kadar
 * çalışan ad kaydedilmeye devam eder. Ekranda GÖRÜNEN her iki hâlde de addır.
 */

/**
 * Bir tetikleme değeri, iki kimliğiyle: operatörün okuduğu `name` ve takım
 * yönetimli bir projede JQL'in tek kabul ettiği `id`.
 *
 * `/onboarding/jira-match-values` uçunun `options` alanı. `id` boş olabilir —
 * kaynağın id vermediği tek hâl, iş tipi listesinin bozulmuş (degraded)
 * kaynaktan gelmesi; o değer yine seçilir, yalnız id biçiminde kaydedilemez.
 */
export interface MatchValueOption {
  readonly name: string;
  readonly id: string;
}

/**
 * Bir ADIN kaydedilecek hâli: takım yönetimliyse id (varsa), değilse ad.
 *
 * Id'si olmayan bir seçenek (bozulmuş iş tipi listesi) takım yönetimli projede
 * de ADIYLA kaydedilir: elde id yokken uydurmak yerine, bugünkü davranış.
 */
export function storedMatchValue(
  name: string,
  options: readonly MatchValueOption[],
  teamManaged: boolean,
): string {
  if (!teamManaged) return name;
  const id = options.find((option) => option.name === name)?.id ?? "";
  return id !== "" ? id : name;
}

/**
 * Kayıtlı `matchValue`nun EKRANDA görünecek hâli.
 *
 * Kural bir id tutuyor olabilir ve operatöre "10008" göstermek, listeye bakıp
 * anlamını çıkaramayacağı bir kural demektir. Listede karşılığı varsa ADI
 * gösterilir; yoksa değer olduğu gibi kalır — tanımadığımız bir değeri tahmin
 * edip yanlış ad yazmak, ham id göstermekten kötüdür.
 */
export function displayMatchValue(value: string, options: readonly MatchValueOption[]): string {
  const byId = options.find((option) => option.id !== "" && option.id === value);
  return byId?.name ?? value;
}
