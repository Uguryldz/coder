import type { RepoRef } from "@maestro/ports";
import {
  EXPIRY_SKEW_SECONDS,
  assertTtlWithinCeiling as assertTtlWithinCeilingShared,
  issuedCredentialIssues,
} from "@maestro/ports";
import { AdoResponseError } from "./errors.js";

/**
 * Issues a short-lived credential. Injected as a callback so this package
 * never imports the secrets package (M44 clean-room DI / M80); the
 * composition root passes `SecretPort.issueShortLived`.
 */
export type SecretIssuer = (
  scope: string,
  ttlSeconds: number,
) => Promise<{ secret: string; expiresAt: string }>;

/**
 * M31 politikasının kendisi `@maestro/ports/push-credential` içinde tek
 * kaynakta yaşıyor; burada yalnızca ADO'ya ait olan iki şey kalıyor: scope
 * öneki ve hata sınıfı. Bu dosya bir dönem GitHub adapter'ıyla birebir aynı
 * ~50 satırı taşıyordu — bir güvenlik kuralının iki kopyası demek, birinde
 * sıkılaştırılıp ötekinde unutulan bir kural demekti.
 */
export { EXPIRY_SKEW_SECONDS, issuedCredentialIssues };

/** Secret scope key for a repository push credential (stable, greppable). */
export function pushScope(repo: RepoRef): string {
  return `ado/${repo.project}/${repo.repo}/push`;
}

/** Requested TTL check (M31), ADO'nun hata sınıfıyla. */
export function assertTtlWithinCeiling(ttlSeconds: number, maxPushTtlSeconds: number): void {
  assertTtlWithinCeilingShared(ttlSeconds, maxPushTtlSeconds, (messages) => {
    throw new AdoResponseError("getPushCredential", messages);
  });
}
