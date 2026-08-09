import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseEnums, parseModels } from "../src/index.js";
import {
  GUARDS_MIGRATION_PATH,
  MIGRATION_LOCK_PATH,
  MIGRATION_PATH,
  allMigrationSql,
  readGuardsMigration,
  readMigration,
  readSchema,
} from "./paths.js";

/**
 * `0001_init` is generated offline with
 * `prisma migrate diff --from-empty --to-schema-datamodel ... --script`
 * (`pnpm -F @maestro/db migration:build`) and is never edited by hand. These
 * tests are the guard that the committed SQL still covers the committed schema
 * — a model added without regenerating fails here instead of at deploy time.
 *
 * `0002_append_only_and_guards` is the one hand-written migration: triggers,
 * CHECK constraints and partial unique indexes have no Prisma syntax, so they
 * cannot be generated. It is tested by content here and, when a database is
 * available, by behaviour in `test/live-guards.test.ts`.
 */
const schema = readSchema();
const sql = readMigration();
const guards = readGuardsMigration();

describe("initial migration", () => {
  it("exists next to a provider lock file", () => {
    expect(existsSync(MIGRATION_PATH)).toBe(true);
    expect(readFileSync(MIGRATION_LOCK_PATH, "utf8")).toContain('provider = "postgresql"');
  });

  /**
   * Reads the WHOLE migration set, not only 0001 — the same reasoning the enum
   * test below already follows. A model added in a later migration is history,
   * not drift: `Gate`, `IdempotencyKey` and `PublishState` arrive in 0004, and
   * a guard that only looked at the initial migration would demand they be
   * back-dated into a generated file that must never be edited by hand.
   *
   * What the guard still catches is the thing it exists for: a model in the
   * schema that NO migration creates, which is a table the deployment will not
   * have.
   */
  it("creates a table for every model", () => {
    const allSql = allMigrationSql();
    const missing = parseModels(schema)
      .map((m) => m.tableName)
      .filter((table) => !allSql.includes(`CREATE TABLE "${table}" (`));
    expect(missing).toEqual([]);
  });

  it("creates a type for every enum", () => {
    const missing = parseEnums(schema)
      .map((e) => e.name)
      .filter((name) => !sql.includes(`CREATE TYPE "${name}" AS ENUM`));
    expect(missing).toEqual([]);
  });

  // Reads the WHOLE migration set, not just 0001: an enum value added later
  // arrives through `ALTER TYPE ... ADD VALUE`, and a guard that only looked at
  // the initial migration would call it drift.
  it("carries every enum value into the migrated types", () => {
    const allSql = allMigrationSql();
    for (const parsed of parseEnums(schema)) {
      const created = allSql
        .split("\n")
        .find((l) => l.startsWith(`CREATE TYPE "${parsed.name}" AS ENUM`));
      expect(created, `no CREATE TYPE for ${parsed.name}`).toBeDefined();
      for (const value of parsed.values) {
        const inCreate = created?.includes(`'${value}'`) ?? false;
        const added = allSql.includes(`ALTER TYPE "${parsed.name}" ADD VALUE '${value}'`);
        expect(inCreate || added, `${parsed.name}.${value} never reaches the database`).toBe(true);
      }
    }
  });

  it("wires the foreign keys as RESTRICT", () => {
    const fks = sql.split("\n").filter((l) => l.includes("FOREIGN KEY"));
    expect(fks.length).toBe(6);
    for (const fk of fks) {
      expect(fk).toContain("ON DELETE RESTRICT");
    }
  });

  it("does not make an org-wide routing rule point at a binding (B-1)", () => {
    expect(sql).not.toMatch(/"RoutingRule".*FOREIGN KEY/);
    expect(sql).toMatch(/"projectKey" VARCHAR\(32\),/); // nullable: NULL = org-wide
  });

  it("declares timestamptz columns, not naive timestamps", () => {
    expect(sql).toContain("TIMESTAMPTZ(3)");
    expect(sql).not.toMatch(/TIMESTAMP\(3\)/);
  });

  it("is destructive-statement free (a first migration only creates)", () => {
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN|TYPE)\b/i);
  });

  it("makes the audit chain unforkable at the index level (M33)", () => {
    expect(sql).toContain('CREATE UNIQUE INDEX "AuditLog_prevHash_key" ON "AuditLog"("prevHash")');
    expect(sql).toContain('CREATE UNIQUE INDEX "AuditLog_hash_key" ON "AuditLog"("hash")');
  });

  it("stops locking a ticket to one run for its lifetime (B-12)", () => {
    expect(sql).not.toContain('CREATE UNIQUE INDEX "WorkflowRun_ticketKey_key"');
    expect(sql).not.toContain('CREATE UNIQUE INDEX "EvidencePackageRow_ticketKey_key"');
    expect(sql).toContain('CREATE INDEX "WorkflowRun_ticketKey_idx"');
  });

  it("keys knowledge documents by (id, version) so a pin survives (M83)", () => {
    expect(sql).toContain('CONSTRAINT "KnowledgeDoc_pkey" PRIMARY KEY ("id","version")');
  });
});

describe("append-only + guard migration (hand-written, 0002)", () => {
  it("exists and says so", () => {
    expect(existsSync(GUARDS_MIGRATION_PATH)).toBe(true);
    expect(guards).toContain("HAND-WRITTEN MIGRATION");
  });

  it("refuses UPDATE, DELETE and TRUNCATE on both append-only tables", () => {
    expect(guards).toMatch(/CREATE OR REPLACE FUNCTION maestro_append_only\(\)/);
    expect(guards).toContain("RAISE EXCEPTION");
    for (const table of ["JournalEntry", "AuditLog"]) {
      expect(guards, table).toMatch(
        new RegExp(`BEFORE UPDATE OR DELETE ON "${table}"[\\s\\S]*?maestro_append_only`),
      );
      expect(guards, table).toMatch(
        new RegExp(`BEFORE TRUNCATE ON "${table}"[\\s\\S]*?maestro_append_only`),
      );
    }
  });

  it("makes four-eyes a database constraint, not a convention (M71)", () => {
    expect(guards).toMatch(
      /CHECK \(NOT "guarded" OR "approvedBy" IS NOT NULL\)/,
    );
  });

  it("allows a ticket to be re-run but never twice at once (M12/M46)", () => {
    expect(guards).toMatch(
      /CREATE UNIQUE INDEX "WorkflowRun_ticketKey_live_key"[\s\S]*?WHERE "status" NOT IN \('done', 'cancelled'\)/,
    );
  });

  it("adds nothing Prisma could have generated itself", () => {
    expect(guards).not.toMatch(/^\s*CREATE TABLE/im);
    expect(guards).not.toMatch(/^\s*CREATE TYPE/im);
  });
});
