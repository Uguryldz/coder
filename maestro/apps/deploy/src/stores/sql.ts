/**
 * A `SqlExecutor` over the Prisma client.
 *
 * `@maestro/storage`'s pg-blob driver needs parameterised SQL and deliberately
 * does not import a database library — it takes this two-method seam instead,
 * which is what keeps its tests offline. Binding it to Prisma is composition
 * root work.
 *
 * `$queryRawUnsafe` sounds alarming and is the correct call here. The "unsafe"
 * in the name refers to the SQL TEXT being a plain string rather than a tagged
 * template — it still parameterises the values passed after it, so the driver's
 * `$1`/`$2` placeholders are bound by Postgres and never interpolated. The
 * alternative, `$queryRaw`, only accepts a tagged template, which a driver
 * building SQL at runtime cannot produce.
 *
 * What must stay true is that the driver never concatenates a caller's value
 * into the string it hands us. It does not: `@maestro/storage` validates its
 * one dynamic fragment (the table name) against a strict pattern at config
 * time and passes every value as a parameter.
 */

/** The subset of the Prisma client this adapter needs. */
export interface RawQueryClient {
  $queryRawUnsafe<R = unknown>(query: string, ...values: unknown[]): Promise<R>;
}

export interface SqlExecutor {
  query<R = Record<string, unknown>>(sql: string, params: readonly unknown[]): Promise<R[]>;
}

export function prismaSqlExecutor(db: RawQueryClient): SqlExecutor {
  return {
    async query<R = Record<string, unknown>>(sql: string, params: readonly unknown[]): Promise<R[]> {
      const rows = await db.$queryRawUnsafe<R[]>(sql, ...params);
      // A statement that returns no result set (an INSERT without RETURNING)
      // gives back a count rather than rows; the driver's callers treat the
      // result as a list either way, so it is normalised here rather than at
      // each call site.
      return Array.isArray(rows) ? rows : [];
    },
  };
}
