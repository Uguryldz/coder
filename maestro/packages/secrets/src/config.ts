import { NonEmpty } from "@maestro/contracts";
import { z } from "zod";

export const SECRET_PORT = "secret";
export const VAULT_DRIVER = "vault";
export const ENV_FILE_DRIVER = "env-file";

/** Mount names an allow-list may contain — same grammar as a key's first segment. */
const Mount = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

/**
 * Least privilege (M6): a driver refuses any key outside these KV mounts
 * BEFORE doing I/O, so a typo'd reference cannot walk another team's tree.
 */
const AllowedMounts = z.array(Mount).min(1);

/** 0 disables the in-memory cache; every entry is evicted at its deadline. */
const CacheTtlSeconds = z.number().int().min(0).max(300);

/**
 * Short-lived credential issuance (M31/M6): dynamic secrets read from
 * `<mount>/<pathPrefix>/<scope>`. `maxTtlSeconds` is the hard ceiling — a
 * larger request is rejected, never silently clamped.
 */
export const ShortLivedConfig = z.object({
  mount: Mount.default("git"),
  pathPrefix: NonEmpty.default("creds"),
  field: NonEmpty.default("token"),
  maxTtlSeconds: z.number().int().positive().max(86_400).default(900),
});
export type ShortLivedConfig = z.infer<typeof ShortLivedConfig>;

export const VaultConfig = z.object({
  allowedMounts: AllowedMounts,
  cacheTtlSeconds: CacheTtlSeconds.default(30),
  addr: z.url(),
  /** Vault Enterprise namespace header, if the bank uses one. */
  namespace: NonEmpty.optional(),
  /** AppRole auth mount; role_id/secret_id are runtime deps, never config. */
  approleMount: Mount.default("approle"),
  requestTimeoutMs: z.number().int().positive().max(120_000).default(10_000),
  /** Renew this many seconds before the client token's lease actually ends. */
  tokenRenewSkewSeconds: z.number().int().min(1).max(3_600).default(60),
  shortLived: ShortLivedConfig.prefault({}),
});
export type VaultConfig = z.infer<typeof VaultConfig>;

export const EnvFileConfig = z.object({
  allowedMounts: AllowedMounts,
  /** Dev only, so caching buys nothing and only widens the leak window. */
  cacheTtlSeconds: CacheTtlSeconds.default(0),
  /** Optional dotenv-style file; process env (or an injected record) wins over it. */
  filePath: NonEmpty.optional(),
  envPrefix: z.string().regex(/^[A-Z][A-Z0-9_]*_$/).default("MAESTRO_SECRET_"),
});
export type EnvFileConfig = z.infer<typeof EnvFileConfig>;
