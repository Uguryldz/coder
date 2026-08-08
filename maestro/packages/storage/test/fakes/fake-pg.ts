import type { SqlExecutor } from "../../src/deps.js";

export interface FakePgRow {
  key: string;
  data: Uint8Array;
  content_type: string;
  tags: string;
  object_lock: boolean;
  retain_until: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * In-memory Postgres stand-in. It recognises only the statements the pg-blob
 * driver is supposed to issue and throws on anything else, so a changed or
 * malformed query fails the test instead of passing unnoticed.
 */
export class FakePg implements SqlExecutor {
  readonly rows = new Map<string, FakePgRow>();
  readonly statements: string[] = [];

  constructor(private readonly table = "storage_blob") {}

  query<R = Record<string, unknown>>(sql: string, params: readonly unknown[]): Promise<R[]> {
    this.statements.push(sql);
    const text = sql.replace(/\s+/g, " ").trim();
    if (text.startsWith(`INSERT INTO ${this.table} `)) return ok(this.insert(text, params));
    if (text === `SELECT data FROM ${this.table} WHERE key = $1`) {
      return ok(this.selectColumns(params, ["data"]));
    }
    if (text === `SELECT object_lock, retain_until FROM ${this.table} WHERE key = $1`) {
      return ok(this.selectColumns(params, ["object_lock", "retain_until"]));
    }
    if (text === `SELECT key FROM ${this.table} WHERE key LIKE $1 ORDER BY key ASC`) {
      return ok(this.selectLike(params));
    }
    if (text === `DELETE FROM ${this.table} WHERE key = $1`) {
      this.rows.delete(stringParam(params, 0));
      return ok([]);
    }
    throw new Error(`FakePg: unrecognised statement: ${text}`);
  }

  private insert(text: string, params: readonly unknown[]): never[] {
    if (!text.includes("ON CONFLICT (key) DO UPDATE")) {
      throw new Error("FakePg: insert must be an upsert on the key");
    }
    if (params.length !== 7) throw new Error(`FakePg: expected 7 insert params, got ${params.length}`);
    const key = stringParam(params, 0);
    const data = params[1];
    if (!(data instanceof Uint8Array)) throw new Error("FakePg: $2 must be bytea (Uint8Array)");
    const at = stringParam(params, 6);
    this.rows.set(key, {
      key,
      data: new Uint8Array(data),
      content_type: stringParam(params, 2),
      tags: stringParam(params, 3),
      object_lock: params[4] === true,
      retain_until: params[5] === null ? null : stringParam(params, 5),
      created_at: this.rows.get(key)?.created_at ?? at,
      updated_at: at,
    });
    return [];
  }

  private selectColumns(params: readonly unknown[], columns: (keyof FakePgRow)[]): unknown[] {
    const row = this.rows.get(stringParam(params, 0));
    if (!row) return [];
    return [Object.fromEntries(columns.map((c) => [c, row[c]]))];
  }

  private selectLike(params: readonly unknown[]): { key: string }[] {
    const pattern = stringParam(params, 0);
    if (!pattern.endsWith("%")) throw new Error("FakePg: prefix search must end with %");
    const literal = pattern.slice(0, -1).replace(/\\([\\%_])/g, "$1");
    return [...this.rows.keys()]
      .filter((key) => key.startsWith(literal))
      .sort()
      .map((key) => ({ key }));
  }
}

function stringParam(params: readonly unknown[], index: number): string {
  const value = params[index];
  if (typeof value !== "string") throw new Error(`FakePg: $${index + 1} must be a string`);
  return value;
}

function ok<T, R>(rows: T[]): Promise<R[]> {
  return Promise.resolve(rows as unknown as R[]);
}
