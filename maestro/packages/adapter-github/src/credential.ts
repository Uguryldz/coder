import type { RepoRef } from "@maestro/ports";
import {
  EXPIRY_SKEW_SECONDS,
  assertTtlWithinCeiling as assertTtlWithinCeilingShared,
  issuedCredentialIssues,
} from "@maestro/ports";
import { GithubResponseError } from "./errors.js";

/**
 * Issues a short-lived credential. Injected as a callback so this package
 * never imports the secrets package (M44 clean-room DI / M80); the
 * composition root passes `SecretPort.issueShortLived`.
 *
 * For GitHub the hardened issuer mints a GitHub App INSTALLATION token
 * (max lifetime one hour, scoped to the repo) — that is the credential this
 * expiry discipline is built for. A fine-grained PAT has a fixed, far-off
 * expiry set at creation; passing one through here would fail the "outlives
 * its ttl" check, which is the correct fail-closed answer (see RAPOR).
 */
export type SecretIssuer = (
  scope: string,
  ttlSeconds: number,
) => Promise<{ secret: string; expiresAt: string }>;

/**
 * M31 politikasının kendisi `@maestro/ports/push-credential` içinde tek
 * kaynakta yaşıyor; burada yalnızca GitHub'a ait olan iki şey kalıyor: scope
 * öneki ve hata sınıfı. Bu dosya bir dönem ADO adapter'ıyla birebir aynı ~50
 * satırı taşıyordu; ayrıntısı ortak modülün başındaki notta.
 */
export { EXPIRY_SKEW_SECONDS, issuedCredentialIssues };

/** Secret scope key for a repository push credential (stable, greppable). */
export function pushScope(repo: RepoRef): string {
  return `github/${repo.project}/${repo.repo}/push`;
}

/** Requested TTL check (M31), GitHub'ın hata sınıfıyla. */
export function assertTtlWithinCeiling(ttlSeconds: number, maxPushTtlSeconds: number): void {
  assertTtlWithinCeilingShared(ttlSeconds, maxPushTtlSeconds, (messages) => {
    throw new GithubResponseError("getPushCredential", messages);
  });
}
