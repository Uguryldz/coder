import { ProjectKey, type TicketKey } from "@maestro/contracts";
import { badRequest } from "./errors.js";

/**
 * KİMLİK DİZELERİNİ BİLEŞENLERİNE AYIRAN SAF YARDIMCILAR.
 *
 * İkisi de bir dönem onları ilk kullanan dosyanın içinde yaşıyordu —
 * `projectKeyOf` alım akışında (`jira-intake.ts`), `splitRepoFullName` ise
 * bir HTTP yolunda (`routes/onboarding.ts`). Sonra başkaları da onlara
 * ihtiyaç duydu ve ortaya döngüler çıktı: alım akışı bir yolu import ediyor,
 * o yol da alım akışını.
 *
 * İkisi de saf: girdi bir dize, çıktı onun parçaları, yan etki yok, bağlam
 * yok. Bir yola ya da bir akışa ait değiller — bu depoda kimliklerin NASIL
 * yazıldığına ait bilgiyi taşıyorlar, ve o bilgi ikisinin de altında.
 */

/**
 * `OPS-119` → `OPS`.
 *
 * Bilet anahtarının proje parçası, görünürlük kararlarının dayandığı şeydir
 * (`canSeeProject`), yani ayrıştırma başarısız olduğunda sessizce boş dönmek
 * YANLIŞ olurdu: biçimsiz bir anahtar reddedilir, geniş görünürlükle
 * geçiştirilmez.
 */
export function projectKeyOf(ticket: TicketKey): string {
  const parsed = ProjectKey.safeParse(ticket.split("-")[0]);
  if (!parsed.success) throw badRequest("ticket_key", { ticket });
  return parsed.data;
}

/**
 * Split a repo's full name (`owner/repo`) into the two registry columns.
 *
 * The wizard sends the exact string it picked from the live SCM list, so the
 * appId is that string verbatim and the two halves are what the SCM/`.docx`
 * adapters read (owner → `adoProject`, repo → `adoRepo`; M100). A name with no
 * slash, or an empty half, is not a repository this platform can bind, so it is
 * refused by name rather than written as a row with a blank column.
 */
export function splitRepoFullName(
  fullName: string,
): { adoProject: string; adoRepo: string } | null {
  const slash = fullName.indexOf("/");
  if (slash <= 0 || slash === fullName.length - 1) return null;
  const adoProject = fullName.slice(0, slash);
  const adoRepo = fullName.slice(slash + 1);
  // A second slash would make `adoRepo` itself contain one; GitHub repo names
  // never do, so this is a malformed pick rather than a nested path.
  if (adoRepo.includes("/")) return null;
  return { adoProject, adoRepo };
}
