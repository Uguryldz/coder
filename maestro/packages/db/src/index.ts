/**
 * @maestro/db — the platform's single Prisma surface: schema, migrations,
 * seed, and the typed client factory. Nothing else in the monorepo imports
 * `@prisma/client` directly.
 */
export { createDb, assertPostgresUrl, InvalidDatabaseUrlError } from "./client.js";
export type { CreateDbOptions, Db, DbLogLevel } from "./client.js";

export { DEFAULT_PARAM_DEFINITIONS, GLOBAL_SCOPE_REF, SEED_ACTOR, seedParams } from "./seed.js";
export type { SeedParamsOptions, SeedParamsResult } from "./seed.js";

export {
  auditPayload,
  buildDemoDataset,
  chainAuditEvents,
  DEMO_GATE_DECISIONS,
  DEMO_NOW,
  DEMO_TICKETS,
  demoRunId,
  NO_PASSWORD_SET,
  seedDemo,
} from "./seed-demo.js";
export type { AuditSeedEvent, DemoDataset, SeedDemoDb } from "./seed-demo.js";

export {
  parseDateTimeFields,
  parseEnums,
  parseModels,
  parseNativeTypes,
} from "./schema-facts.js";
export type { SchemaEnum, SchemaModel } from "./schema-facts.js";

/** Package-relative path of the schema — resolved by tooling and tests. */
export const PRISMA_SCHEMA_RELATIVE_PATH = "prisma/schema.prisma";

/** Package-relative path of the generated initial migration. */
export const INITIAL_MIGRATION_RELATIVE_PATH = "prisma/migrations/0001_init/migration.sql";
