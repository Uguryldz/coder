import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  INITIAL_MIGRATION_RELATIVE_PATH,
  PRISMA_SCHEMA_RELATIVE_PATH,
} from "../src/index.js";

/** Absolute path of the `@maestro/db` package root. */
export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const SCHEMA_PATH = join(PACKAGE_ROOT, PRISMA_SCHEMA_RELATIVE_PATH);
export const MIGRATION_PATH = join(PACKAGE_ROOT, INITIAL_MIGRATION_RELATIVE_PATH);
export const MIGRATION_LOCK_PATH = join(PACKAGE_ROOT, "prisma/migrations/migration_lock.toml");

export function readSchema(): string {
  return readFileSync(SCHEMA_PATH, "utf8");
}

export function readMigration(): string {
  return readFileSync(MIGRATION_PATH, "utf8");
}
