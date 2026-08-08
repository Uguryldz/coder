import { PortRegistry, type SecretPort } from "@maestro/ports";
import { describe, expect, it } from "vitest";
import {
  createVaultSecretPort,
  ENV_FILE_DRIVER,
  EnvFileConfig,
  EnvFileSecretPort,
  registerSecretDrivers,
  SECRET_PORT,
  SecretConfigError,
  VAULT_DRIVER,
  VaultConfig,
  VaultSecretPort,
} from "../src/index.js";
import { APPROLE, ENV_FILE_CONFIG, stubFetch, VAULT_CONFIG } from "./helpers.js";

const vaultDeps = { approle: APPROLE, fetchImpl: stubFetch([]).fetchImpl };

describe("driver registration (M44)", () => {
  it("registers both drivers on the secret port", () => {
    const registry = new PortRegistry();
    registerSecretDrivers(registry);

    expect(registry.drivers(SECRET_PORT).sort()).toEqual([ENV_FILE_DRIVER, VAULT_DRIVER]);
  });

  it("resolves the vault driver into a SecretPort", () => {
    const registry = new PortRegistry();
    registerSecretDrivers(registry);

    const factory = registry.resolve<SecretPort>(SECRET_PORT, VAULT_DRIVER);
    expect(factory({ ...VAULT_CONFIG, deps: vaultDeps })).toBeInstanceOf(VaultSecretPort);
  });

  it("resolves the env-file driver into a SecretPort", () => {
    const registry = new PortRegistry();
    registerSecretDrivers(registry);

    const factory = registry.resolve<SecretPort>(SECRET_PORT, ENV_FILE_DRIVER);
    expect(factory({ ...ENV_FILE_CONFIG, deps: { env: {}, nodeEnv: "test" } })).toBeInstanceOf(EnvFileSecretPort);
  });

  it("refuses to resolve an unknown driver", () => {
    const registry = new PortRegistry();
    registerSecretDrivers(registry);

    expect(() => registry.resolve(SECRET_PORT, "cyberark")).toThrow(/no driver "cyberark"/);
  });
});

describe("configuration validation", () => {
  it("applies the documented defaults", () => {
    const config = VaultConfig.parse(VAULT_CONFIG);

    expect(config.approleMount).toBe("approle");
    expect(config.cacheTtlSeconds).toBe(30);
    expect(config.tokenRenewSkewSeconds).toBe(60);
    expect(config.requestTimeoutMs).toBe(10_000);
    expect(VaultConfig.parse({ addr: VAULT_CONFIG.addr, allowedMounts: ["git"] }).shortLived).toEqual({
      mount: "git",
      pathPrefix: "creds",
      field: "token",
      maxTtlSeconds: 900,
    });
  });

  it("defaults the env-file cache to disabled", () => {
    expect(EnvFileConfig.parse(ENV_FILE_CONFIG).cacheTtlSeconds).toBe(0);
    expect(EnvFileConfig.parse(ENV_FILE_CONFIG).envPrefix).toBe("MAESTRO_SECRET_");
  });

  it("reports every offending field of an invalid vault config", () => {
    const error = (() => {
      try {
        createVaultSecretPort({ addr: "not-a-url", allowedMounts: [], deps: { approle: APPROLE } });
      } catch (e) {
        return e as Error;
      }
    })();

    expect(error).toBeInstanceOf(SecretConfigError);
    expect(error?.message).toMatch(/addr/);
    expect(error?.message).toMatch(/allowedMounts/);
  });

  it("requires at least one allowed mount — an empty allow-list is not a wildcard", () => {
    expect(EnvFileConfig.safeParse({ allowedMounts: [] }).success).toBe(false);
  });

  it("caps the short-lived ceiling and the cache TTL", () => {
    expect(VaultConfig.safeParse({ ...VAULT_CONFIG, cacheTtlSeconds: 301 }).success).toBe(false);
    expect(
      VaultConfig.safeParse({ ...VAULT_CONFIG, shortLived: { maxTtlSeconds: 86_401 } }).success,
    ).toBe(false);
  });
});
