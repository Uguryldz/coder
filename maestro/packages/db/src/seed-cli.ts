import { createDb } from "./client.js";
import { seedParams } from "./seed.js";
import { seedDemo } from "./seed-demo.js";

/**
 * Seed runner: `pnpm -F @maestro/db seed [--params-only]`.
 *
 * Needs a reachable database, so it is not part of the offline test suite —
 * the data it writes is, though (see test/seed.test.ts and test/seed-demo.test.ts).
 */
export async function runSeedCli(
  env: Record<string, string | undefined>,
  argv: readonly string[] = [],
): Promise<void> {
  const url = env["DATABASE_URL"];
  if (url === undefined || url.trim().length === 0) {
    throw new Error("DATABASE_URL is required to run the seed");
  }

  const paramsOnly = argv.includes("--params-only");
  const db = createDb(url);
  try {
    const params = await seedParams(db);
    console.log(`seeded ${params.definitions} parameter definitions`);

    if (paramsOnly) return;
    const counts = await seedDemo(db);
    for (const [table, count] of Object.entries(counts)) {
      console.log(`seeded ${count} ${table}`);
    }
  } finally {
    await db.$disconnect();
  }
}

await runSeedCli(process.env, process.argv.slice(2));
