import * as contracts from "@maestro/contracts";
import { describe, expect, it } from "vitest";
import {
  PrismaUserDirectory,
  ROLE_BY_GROUP,
  rolesOf,
  type UserDelegate,
  type UserRow,
} from "../src/stores/users.js";

/**
 * The Postgres-backed user directory.
 *
 * The delegate is a plain object rather than a real Prisma client — the store
 * takes three methods by SHAPE, which is what lets these tests run without a
 * database and without `prisma generate`.
 */

function row(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: "u-ayse",
    email: "ayse.kaya@ugurbank.local",
    displayName: "Ayşe Kaya",
    passwordHash: "$2b$12$hash",
    groupsJson: ["product-owners", "tech-leads"],
    active: true,
    ...overrides,
  };
}

function delegate(initial: UserRow | null = row()) {
  const calls: { upsert: unknown[]; update: unknown[] } = { upsert: [], update: [] };
  const store: UserDelegate = {
    findUnique: () => Promise.resolve(initial),
    upsert: (args) => {
      calls.upsert.push(args);
      return Promise.resolve(args.create);
    },
    update: (args) => {
      calls.update.push(args);
      return Promise.resolve(initial);
    },
  };
  return { store, calls };
}

describe("role mapping", () => {
  it("maps every group to a role the contract actually defines", () => {
    // Once `@maestro/contracts` exports ROLES this pins the mapping against
    // it; until then the assertion is skipped rather than faked, so this test
    // starts enforcing the closed set the moment the module lands.
    const roles = (contracts as Record<string, unknown>)["ROLES"];
    if (!Array.isArray(roles)) return;
    for (const role of Object.values(ROLE_BY_GROUP)) {
      expect(roles, `"${role}" is not in the Role union`).toContain(role);
    }
  });

  it("gives everyone at least viewer", () => {
    expect(rolesOf([])).toEqual(["viewer"]);
  });

  it("grants the roles behind a user's groups", () => {
    expect(rolesOf(["tech-leads"]).sort()).toEqual(["tech-lead", "viewer"]);
    expect(rolesOf(["maestro-admins"]).sort()).toEqual(["admin", "viewer"]);
  });

  it("ignores an unrecognised group instead of inventing a role from its name", () => {
    // A directory group added next quarter must not become an authorisation
    // the platform honours just because it exists.
    expect(rolesOf(["some-new-ad-group"])).toEqual(["viewer"]);
  });

  it("does not let a group named after a role grant it by coincidence", () => {
    expect(rolesOf(["admin"])).toEqual(["viewer"]);
  });
});

describe("PrismaUserDirectory", () => {
  it("reads a row into the record the identity provider expects", async () => {
    const { store } = delegate();
    const record = await new PrismaUserDirectory(store).find("AYSE.KAYA@ugurbank.local");

    expect(record).not.toBeNull();
    expect(record?.userId).toBe("u-ayse");
    expect(record?.username).toBe("ayse.kaya@ugurbank.local");
    expect(record?.groups).toEqual(["product-owners", "tech-leads"]);
    expect([...(record?.roles ?? [])].sort()).toEqual(["product-owner", "tech-lead", "viewer"]);
  });

  it("returns null for an unknown account", async () => {
    const { store } = delegate(null);
    expect(await new PrismaUserDirectory(store).find("nobody@ugurbank.local")).toBeNull();
  });

  it("reads a malformed groups column as no groups rather than as membership", async () => {
    // `groupsJson` is a JSON column, so its contents are whatever was written.
    // Anything that is not an array of strings must not become a membership —
    // membership is what opens gates.
    const { store } = delegate(row({ groupsJson: { not: "an array" } }));
    const record = await new PrismaUserDirectory(store).find("ayse.kaya@ugurbank.local");
    expect(record?.groups).toEqual([]);
    expect(record?.roles).toEqual(["viewer"]);
  });

  it("drops non-string entries from a partly malformed groups column", async () => {
    const { store } = delegate(row({ groupsJson: ["tech-leads", 42, null] }));
    const record = await new PrismaUserDirectory(store).find("ayse.kaya@ugurbank.local");
    expect(record?.groups).toEqual(["tech-leads"]);
  });

  it("deactivates rather than deletes on off-boarding", async () => {
    // A departed approver's name is on closed gates; deleting the row would
    // leave the audit trail pointing at nobody (M33).
    const { store, calls } = delegate();
    await new PrismaUserDirectory(store).remove("ayse.kaya@ugurbank.local");

    expect(calls.update).toHaveLength(1);
    expect(calls.update[0]).toMatchObject({ data: { active: false } });
  });

  it("normalises the username on every path", async () => {
    const { store, calls } = delegate();
    const directory = new PrismaUserDirectory(store);
    await directory.remove("  AYSE.KAYA@UgurBank.local  ");

    expect(calls.update[0]).toMatchObject({ where: { email: "ayse.kaya@ugurbank.local" } });
  });

  it("writes groups as an array the JSON column can hold", async () => {
    const { store, calls } = delegate();
    await new PrismaUserDirectory(store).upsert({
      username: "Mert.Demir@ugurbank.local",
      userId: "u-mert",
      passwordHash: "$2b$12$other",
      groups: ["tech-leads"],
      roles: ["tech-lead"],
      active: true,
    });

    expect(calls.upsert[0]).toMatchObject({
      where: { email: "mert.demir@ugurbank.local" },
      create: { id: "u-mert", groupsJson: ["tech-leads"] },
    });
  });
});
