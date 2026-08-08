/** Secret port (M80): vault + env-file drivers; cyberark/keyvault later. */
export interface SecretPort {
  get(key: string): Promise<string>;
  /** Short-lived scoped credential (e.g. repo push token — M31). */
  issueShortLived(scope: string, ttlSeconds: number): Promise<{ secret: string; expiresAt: string }>;
}
