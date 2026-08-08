import type { SecretPort } from "@maestro/ports";
import { type Clock, systemClock, TtlCache } from "./cache.js";
import { VAULT_DRIVER, type VaultConfig } from "./config.js";
import {
  SecretConfigError,
  SecretExpiredError,
  SecretNotFoundError,
  SecretPermissionDeniedError,
  SecretTtlError,
  VaultResponseError,
} from "./errors.js";
import { parseScope } from "./keys.js";
import { resolveKey, toIsoDateTime } from "./shared.js";
import type { VaultBody, VaultClient, VaultReadResult } from "./vault-client.js";

export interface VaultSecretPortOptions {
  config: VaultConfig;
  client: VaultClient;
  clock?: Clock;
}

/**
 * SecretPort over HashiCorp Vault KV v2 (M80) plus dynamic short-lived
 * credentials (M31/M6). Fail-closed throughout: an absent, empty or expired
 * secret is an error, never a silent fallback.
 */
export class VaultSecretPort implements SecretPort {
  readonly driver = VAULT_DRIVER;
  readonly config: VaultConfig;
  readonly #client: VaultClient;
  readonly #cache: TtlCache<string>;
  readonly #clock: Clock;

  constructor(options: VaultSecretPortOptions) {
    const { config } = options;
    if (!config.allowedMounts.includes(config.shortLived.mount)) {
      throw new SecretConfigError(
        `shortLived.mount "${config.shortLived.mount}" is not in allowedMounts — issuance would always be denied`,
      );
    }
    this.config = config;
    this.#client = options.client;
    this.#clock = options.clock ?? systemClock;
    this.#cache = new TtlCache<string>(config.cacheTtlSeconds, this.#clock);
  }

  async get(key: string): Promise<string> {
    const parsed = resolveKey(key, this.config.allowedMounts, VAULT_DRIVER);

    const cached = this.#cache.get(key);
    if (cached !== undefined) return cached;

    const where = `${parsed.mount}/${parsed.path}`;
    const result = await this.#client.read(`${parsed.mount}/data/${parsed.path}`, `read ${where}`);
    const body = unwrap(result, key);

    const value = readKvField(body.data, parsed.field);
    if (value === undefined) throw new SecretNotFoundError(key, VAULT_DRIVER);

    this.#cache.set(key, value);
    return value;
  }

  /**
   * Issue a scoped credential from a dynamic secrets engine. The TTL is
   * mandatory and capped by `shortLived.maxTtlSeconds`; an oversized request is
   * REJECTED rather than clamped, so a caller can never believe it holds a
   * longer-lived credential than Vault actually granted.
   */
  async issueShortLived(scope: string, ttlSeconds: number): Promise<{ secret: string; expiresAt: string }> {
    const parsedScope = parseScope(scope);
    const { mount, pathPrefix, field, maxTtlSeconds } = this.config.shortLived;

    if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
      throw new SecretTtlError(ttlSeconds, maxTtlSeconds, "ttl must be a positive whole number of seconds");
    }
    if (ttlSeconds > maxTtlSeconds) {
      throw new SecretTtlError(ttlSeconds, maxTtlSeconds, "above the configured ceiling (M31)");
    }

    const operation = `issue ${mount}/${pathPrefix}/${parsedScope}`;
    const result = await this.#client.read(`${mount}/${pathPrefix}/${parsedScope}`, operation, {
      ttl: `${ttlSeconds}s`,
    });
    const body = unwrap(result, `${mount}/${pathPrefix}/${parsedScope}`);

    const secret = readField(body.data, field);
    if (secret === undefined) throw new VaultResponseError(operation, `field "${field}" is missing or empty`);

    const lease = body.lease_duration;
    const grantedSeconds = typeof lease === "number" && Number.isFinite(lease) ? lease : ttlSeconds;
    const expiresAtMs = this.#clock() + grantedSeconds * 1000;
    if (grantedSeconds <= 0 || expiresAtMs <= this.#clock()) {
      throw new SecretExpiredError(parsedScope, toIsoDateTime(expiresAtMs));
    }

    // Never cached: a short-lived credential is single-use by design.
    return { secret, expiresAt: toIsoDateTime(expiresAtMs) };
  }

  /** Drops cached values, e.g. after a rotation signal. */
  invalidate(): void {
    this.#cache.clear();
  }

  toJSON(): { driver: string; addr: string; allowedMounts: string[]; cacheTtlSeconds: number } {
    return {
      driver: this.driver,
      addr: this.config.addr,
      allowedMounts: [...this.config.allowedMounts],
      cacheTtlSeconds: this.config.cacheTtlSeconds,
    };
  }

  toString(): string {
    return `VaultSecretPort(${this.config.addr})`;
  }

}

/** 403 → denied, 404 → not found; both named after the key the caller asked for. */
function unwrap(result: VaultReadResult, key: string): VaultBody {
  if (result.ok) return result.body;
  if (result.kind === "denied") throw new SecretPermissionDeniedError(key, VAULT_DRIVER, "vault_denied");
  throw new SecretNotFoundError(key, VAULT_DRIVER);
}

/** KV v2 nests the secret object one level deeper: `{ data: { data: {...} } }`. */
function readKvField(payload: unknown, field: string): string | undefined {
  const inner = (payload as { data?: unknown } | null | undefined)?.data;
  return readField(inner, field);
}

/** An empty value is treated as absent — M6 forbids booting on a placeholder. */
function readField(payload: unknown, field: string): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const value = (payload as Record<string, unknown>)[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
