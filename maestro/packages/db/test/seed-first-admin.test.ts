import { describe, expect, it } from "vitest";
import {
  FIRST_ADMIN_GROUP,
  FIRST_ADMIN_PASSWORD,
  FIRST_ADMIN_USERNAME,
  seedFirstAdmin,
  type SeedFirstAdminDb,
} from "../src/index.js";

/**
 * The offline half of the first-run bootstrap (banking standard). No database:
 * a fake `user` delegate that remembers what was created, so we can prove the
 * seed plants exactly ONE admin, never clobbers a real one, and never resets a
 * changed password back to `admin123`.
 */

interface Row {
  id: string;
  email: string;
  displayName: string;
  passwordHash: string;
  groupsJson: string[];
  active: boolean;
  mustChangePassword: boolean;
}

function fakeDb(seed: readonly Row[] = []): { db: SeedFirstAdminDb; rows: Row[] } {
  const rows: Row[] = seed.map((r) => ({ ...r, groupsJson: [...r.groupsJson] }));
  const db: SeedFirstAdminDb = {
    user: {
      findFirst: (args) => {
        const wanted = args.where.groupsJson.array_contains;
        const hit = rows.find((r) => wanted.every((g) => r.groupsJson.includes(g)));
        return Promise.resolve(hit ? { id: hit.id } : null);
      },
      create: (args) => {
        rows.push({ ...args.data, groupsJson: [...args.data.groupsJson] });
        return Promise.resolve(args.data);
      },
    },
  };
  return { db, rows };
}

/** A hasher whose output is inspectable, so the test never runs real bcrypt. */
const fakeHash = (password: string): Promise<string> => Promise.resolve(`hashed:${password}`);

describe("seedFirstAdmin (first-run bootstrap, M8)", () => {
  it("plants admin/admin123 with mustChangePassword on an empty database", async () => {
    const { db, rows } = fakeDb();

    const result = await seedFirstAdmin(db, fakeHash);

    expect(result).toEqual({ seeded: true, reason: "created" });
    expect(rows).toHaveLength(1);
    const admin = rows[0]!;
    expect(admin.email).toBe(FIRST_ADMIN_USERNAME);
    expect(admin.email).toBe("admin");
    expect(admin.passwordHash).toBe(`hashed:${FIRST_ADMIN_PASSWORD}`);
    expect(admin.passwordHash).toBe("hashed:admin123");
    expect(admin.groupsJson).toContain(FIRST_ADMIN_GROUP);
    expect(admin.active).toBe(true);
    expect(admin.mustChangePassword).toBe(true);
  });

  it("is a no-op when an admin already exists — never a second admin", async () => {
    const { db, rows } = fakeDb([
      {
        id: "ayse.kaya@ugurbank.local",
        email: "ayse.kaya",
        displayName: "Ayşe Kaya",
        passwordHash: "hashed:real-strong-password",
        groupsJson: [FIRST_ADMIN_GROUP],
        active: true,
        mustChangePassword: false,
      },
    ]);

    const result = await seedFirstAdmin(db, fakeHash);

    expect(result).toEqual({ seeded: false, reason: "admin_exists" });
    expect(rows).toHaveLength(1);
    expect(rows.some((r) => r.email === "admin")).toBe(false);
  });

  it("does not reset the flag after the bootstrap admin has changed its password", async () => {
    // The bootstrap admin, AFTER a successful change-password: still an admin
    // (still in the admin group), flag cleared, password no longer admin123.
    const changed: Row = {
      id: "admin",
      email: "admin",
      displayName: "Yönetici",
      passwordHash: "hashed:A-Real-Strong-Password-1!",
      groupsJson: [FIRST_ADMIN_GROUP],
      active: true,
      mustChangePassword: false,
    };
    const { db, rows } = fakeDb([changed]);

    const result = await seedFirstAdmin(db, fakeHash);

    expect(result.seeded).toBe(false);
    expect(rows).toHaveLength(1);
    // The seed left the changed credential and the cleared flag untouched.
    expect(rows[0]!.mustChangePassword).toBe(false);
    expect(rows[0]!.passwordHash).toBe("hashed:A-Real-Strong-Password-1!");
  });

  it("is idempotent: a second run after planting the bootstrap admin creates nothing", async () => {
    const { db, rows } = fakeDb();

    await seedFirstAdmin(db, fakeHash);
    const second = await seedFirstAdmin(db, fakeHash);

    expect(second.seeded).toBe(false);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.mustChangePassword).toBe(true); // still the fresh bootstrap flag, not reset
  });
});
