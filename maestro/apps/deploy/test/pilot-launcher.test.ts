import { describe, expect, it, vi } from "vitest";
import type { Db, createDb } from "@maestro/db";
import { variantReaderFromEnv } from "../src/bin/pilot.js";

/**
 * The LIVE pilot launcher's DB-first wiring (`apps/deploy/src/bin/pilot.ts`).
 *
 * `main.ts` boots the pilot DB-FREE (env fallback, warning). This launcher is
 * the one that hands the pilot a Postgres-backed `VariantModelReader`, so the
 * model comes from the variant (Studio/DB), not env. These pin the decision that
 * chooses that path — offline, with a fake `createDb`, so no real Postgres is
 * touched:
 *
 *  · with a `DATABASE_URL`, a reader is built over the DB's `variantVersion`
 *    delegate, and it resolves a variant's active model DB-first;
 *  · with no `DATABASE_URL`, the launcher fails closed (M6) — an operator with
 *    no database is meant to run the standalone `main.ts`, not this binary.
 */

/** A fake `createDb` whose `variantVersion.findMany` returns seeded rows. */
function fakeCreateDb(
  seed: { version: number; model: string }[],
): { makeDb: typeof createDb; calledWith: string[] } {
  const calledWith: string[] = [];
  const makeDb = ((url: string) => {
    calledWith.push(url);
    return {
      variantVersion: {
        findMany: () =>
          Promise.resolve(seed.slice().sort((a, b) => b.version - a.version)),
      },
    } as unknown as Db;
  }) as typeof createDb;
  return { makeDb, calledWith };
}

describe("variantReaderFromEnv", () => {
  it("builds a Postgres-backed reader that resolves the active model DB-first", async () => {
    const { makeDb, calledWith } = fakeCreateDb([
      { version: 1, model: "env-seed/gpt-4o-mini" },
      { version: 2, model: "studio-set/claude-x" },
    ]);
    const reader = variantReaderFromEnv(
      { DATABASE_URL: "postgresql://maestro:pw@localhost:55432/maestro" },
      makeDb,
    );

    // The URL from env reached createDb (the reader is over that DB).
    expect(calledWith).toEqual(["postgresql://maestro:pw@localhost:55432/maestro"]);
    // And the reader answers with the ACTIVE (newest) version's model — what an
    // admin last published in Studio, not the version-1 env seed.
    expect(await reader.activeModel("analyst-default")).toBe("studio-set/claude-x");
  });

  it("fails closed when DATABASE_URL is absent (run main.ts instead)", () => {
    const makeDb = vi.fn();
    expect(() => variantReaderFromEnv({}, makeDb as unknown as typeof createDb)).toThrow(
      /DATABASE_URL is required/,
    );
    // It never tried to build a client with a missing URL.
    expect(makeDb).not.toHaveBeenCalled();
  });

  it("treats a blank DATABASE_URL as absent", () => {
    const makeDb = vi.fn();
    expect(() =>
      variantReaderFromEnv({ DATABASE_URL: "   " }, makeDb as unknown as typeof createDb),
    ).toThrow(/DATABASE_URL is required/);
    expect(makeDb).not.toHaveBeenCalled();
  });
});
