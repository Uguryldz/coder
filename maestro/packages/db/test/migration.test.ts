import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseEnums, parseModels } from "../src/index.js";
import { MIGRATION_LOCK_PATH, MIGRATION_PATH, readMigration, readSchema } from "./paths.js";

/**
 * The initial migration is generated offline with
 * `prisma migrate diff --from-empty --to-schema-datamodel ... --script`
 * (`pnpm -F @maestro/db migration:build`). These tests are the guard that the
 * committed SQL still covers the committed schema — a model added without
 * regenerating fails here instead of at deploy time.
 */
const schema = readSchema();
const sql = readMigration();

describe("initial migration", () => {
  it("exists next to a provider lock file", () => {
    expect(existsSync(MIGRATION_PATH)).toBe(true);
    expect(readFileSync(MIGRATION_LOCK_PATH, "utf8")).toContain('provider = "postgresql"');
  });

  it("creates a table for every model", () => {
    const missing = parseModels(schema)
      .map((m) => m.tableName)
      .filter((table) => !sql.includes(`CREATE TABLE "${table}" (`));
    expect(missing).toEqual([]);
  });

  it("creates a type for every enum", () => {
    const missing = parseEnums(schema)
      .map((e) => e.name)
      .filter((name) => !sql.includes(`CREATE TYPE "${name}" AS ENUM`));
    expect(missing).toEqual([]);
  });

  it("carries every enum value into the generated type", () => {
    for (const parsed of parseEnums(schema)) {
      const line = sql.split("\n").find((l) => l.startsWith(`CREATE TYPE "${parsed.name}" AS ENUM`));
      expect(line, `no CREATE TYPE for ${parsed.name}`).toBeDefined();
      for (const value of parsed.values) {
        expect(line).toContain(`'${value}'`);
      }
    }
  });

  it("wires the foreign keys as RESTRICT", () => {
    const fks = sql.split("\n").filter((l) => l.includes("FOREIGN KEY"));
    expect(fks.length).toBe(7);
    for (const fk of fks) {
      expect(fk).toContain("ON DELETE RESTRICT");
    }
  });

  it("declares timestamptz columns, not naive timestamps", () => {
    expect(sql).toContain("TIMESTAMPTZ(3)");
    expect(sql).not.toMatch(/TIMESTAMP\(3\)/);
  });

  it("is destructive-statement free (a first migration only creates)", () => {
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN|TYPE)\b/i);
  });
});
