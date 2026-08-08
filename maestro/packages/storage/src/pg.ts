import { z } from "zod";
import { CapabilityNotSupportedError } from "@maestro/ports";
import type { StoragePort } from "@maestro/ports";
import type { Clock, SqlExecutor } from "./deps.js";
import { systemClock } from "./deps.js";
import {
  ObjectLockedError,
  ObjectLockNotConfiguredError,
  ObjectNotFoundError,
  StorageConfigError,
} from "./errors.js";
import {
  assertValidKey,
  assertValidPrefix,
  RETENTION_YEARS_DEFAULT,
  retainUntil,
  RetentionClass,
  retentionPolicy,
  retentionTags,
} from "./keys.js";

/**
 * pg-blob driver options (M5: the small-installation backend, no S3 required).
 * Same retention semantics as s3-compat so callers cannot tell the two apart.
 */
export const PgBlobStorageOptions = z.object({
  /** Physical table; qualified name is validated, never interpolated blindly. */
  table: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/, "table must be a plain [schema.]name")
    .default("storage_blob"),
  /** Optional tenant prefix prepended to every key. Invisible to callers. */
  keyPrefix: z.string().default(""),
  /** M57 WORM emulation. Absent means objectLock puts are refused, not downgraded. */
  objectLock: z
    .object({
      mode: z.enum(["COMPLIANCE", "GOVERNANCE"]),
      years: z.number().int().positive().default(RETENTION_YEARS_DEFAULT),
    })
    .optional(),
  retentionClass: RetentionClass.default("evidence"),
});
export type PgBlobStorageOptions = z.output<typeof PgBlobStorageOptions>;

export interface PgBlobStorageDeps {
  sql: SqlExecutor;
  now?: Clock | undefined;
}

interface BlobRow {
  data: Uint8Array;
}

interface LockRow {
  object_lock: boolean;
  retain_until: string | null;
}

/** DDL for the backing table; applied by the `db` packet's migration. */
export function pgBlobTableDdl(table = "storage_blob"): string {
  return [
    `CREATE TABLE IF NOT EXISTS ${PgBlobStorageOptions.shape.table.parse(table)} (`,
    `  key text PRIMARY KEY,`,
    `  data bytea NOT NULL,`,
    `  content_type text NOT NULL,`,
    `  tags jsonb NOT NULL,`,
    `  object_lock boolean NOT NULL DEFAULT false,`,
    `  retain_until timestamptz,`,
    `  created_at timestamptz NOT NULL,`,
    `  updated_at timestamptz NOT NULL`,
    `)`,
  ].join("\n");
}

export class PgBlobStorage implements StoragePort {
  private readonly now: Clock;

  constructor(
    private readonly options: PgBlobStorageOptions,
    private readonly deps: PgBlobStorageDeps,
  ) {
    if (options.keyPrefix !== "") assertValidPrefix(options.keyPrefix);
    this.now = deps.now ?? systemClock;
  }

  async put(
    key: string,
    data: Uint8Array,
    opts?: { contentType?: string; objectLock?: boolean },
  ): Promise<void> {
    const full = this.fullKey(key);
    let retainUntilAt: string | null = null;
    if (opts?.objectLock === true) {
      const lock = this.options.objectLock;
      if (!lock) throw new ObjectLockNotConfiguredError(key);
      retainUntilAt = retainUntil(this.now().toISOString(), lock.years);
    }
    await this.assertNotRetained(key, full);
    const at = this.now().toISOString();
    await this.deps.sql.query(
      `INSERT INTO ${this.options.table} ` +
        `(key, data, content_type, tags, object_lock, retain_until, created_at, updated_at) ` +
        `VALUES ($1, $2, $3, $4, $5, $6, $7, $7) ` +
        `ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, ` +
        `content_type = EXCLUDED.content_type, tags = EXCLUDED.tags, ` +
        `object_lock = EXCLUDED.object_lock, retain_until = EXCLUDED.retain_until, ` +
        `updated_at = EXCLUDED.updated_at`,
      [
        full,
        data,
        opts?.contentType ?? "application/octet-stream",
        JSON.stringify(retentionTags(retentionPolicy(this.options.retentionClass))),
        retainUntilAt !== null,
        retainUntilAt,
        at,
      ],
    );
  }

  async get(key: string): Promise<Uint8Array> {
    const full = this.fullKey(key);
    const rows = await this.deps.sql.query<BlobRow>(
      `SELECT data FROM ${this.options.table} WHERE key = $1`,
      [full],
    );
    const row = rows[0];
    if (!row) throw new ObjectNotFoundError(key);
    return new Uint8Array(row.data);
  }

  async list(prefix: string): Promise<string[]> {
    assertValidPrefix(prefix);
    const rows = await this.deps.sql.query<{ key: string }>(
      `SELECT key FROM ${this.options.table} WHERE key LIKE $1 ORDER BY key ASC`,
      [`${likeEscape(`${this.options.keyPrefix}${prefix}`)}%`],
    );
    return rows.map((row) => row.key.slice(this.options.keyPrefix.length));
  }

  /** Idempotent by contract: deleting an absent key is a no-op on both drivers. */
  async delete(key: string): Promise<void> {
    const full = this.fullKey(key);
    await this.assertNotRetained(key, full);
    await this.deps.sql.query(`DELETE FROM ${this.options.table} WHERE key = $1`, [full]);
  }

  /**
   * Postgres has no signed-URL concept and this package will not invent an
   * unauthenticated one; the BFF serves pg-blob objects behind its own auth.
   */
  presign(_key: string, _ttlSeconds: number): Promise<string> {
    return Promise.reject(new CapabilityNotSupportedError("StoragePort", "presign"));
  }

  /** WORM enforcement (M57): a retained row may be neither overwritten nor deleted. */
  private async assertNotRetained(key: string, full: string): Promise<void> {
    if (!this.options.objectLock) return;
    const rows = await this.deps.sql.query<LockRow>(
      `SELECT object_lock, retain_until FROM ${this.options.table} WHERE key = $1`,
      [full],
    );
    const row = rows[0];
    if (!row?.object_lock || row.retain_until === null) return;
    if (new Date(row.retain_until).getTime() > this.now().getTime()) {
      throw new ObjectLockedError(key, new Date(row.retain_until).toISOString());
    }
  }

  private fullKey(key: string): string {
    assertValidKey(key);
    return `${this.options.keyPrefix}${key}`;
  }
}

/** Escapes LIKE wildcards so a prefix containing % or _ stays literal. */
function likeEscape(value: string): string {
  return value.replace(/([\\%_])/g, "\\$1");
}

export function createPgBlobStorage(options: unknown, deps: PgBlobStorageDeps): StoragePort {
  const parsed = PgBlobStorageOptions.safeParse(options);
  if (!parsed.success) {
    throw new StorageConfigError(
      parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    );
  }
  return new PgBlobStorage(parsed.data, deps);
}
