import { describe, expect, it } from "vitest";
import {
  assertPassword,
  BcryptPasswordHasher,
  checkPassword,
  DEFAULT_PASSWORD_POLICY,
  PasswordPolicyError,
} from "../src/auth/password.js";
import { InMemoryUserDirectory, LocalIdentityProvider } from "../src/auth/local-identity.js";

describe("password policy (M8)", () => {
  it("accepts a password that meets every rule", () => {
    expect(checkPassword("Maestro!Test-2026", "ayse.kaya")).toEqual([]);
  });

  it("names every rule the candidate breaks at once", () => {
    expect(checkPassword("kisa", "ayse.kaya").sort()).toEqual(
      ["no_digit", "no_symbol", "no_upper", "too_short"].sort(),
    );
  });

  it("rejects a password that is at most the login with decoration", () => {
    expect(checkPassword("Ayse.Kaya-2026!", "ayse.kaya")).toContain("contains_username");
  });

  it("matches the login case-insensitively and ignores the domain", () => {
    expect(checkPassword("XxAYSE.KAYAxx-1!", "Ayse.Kaya@ugurbank.local")).toContain(
      "contains_username",
    );
  });

  it("caps the length at bcrypt's 72 bytes, so the whole password is really checked", () => {
    const long = `Aa1!${"x".repeat(80)}`;
    expect(Buffer.byteLength(long, "utf8")).toBeGreaterThan(DEFAULT_PASSWORD_POLICY.maxBytes);
    expect(checkPassword(long, "ayse.kaya")).toContain("too_long");
  });

  it("counts bytes rather than characters for multi-byte passwords", () => {
    const turkish = `Aa1!${"ş".repeat(35)}`;
    expect(turkish.length).toBeLessThan(DEFAULT_PASSWORD_POLICY.maxBytes);
    expect(checkPassword(turkish, "ayse.kaya")).toContain("too_long");
  });

  it("throws a 400-shaped error listing the violations", () => {
    try {
      assertPassword("kisa", "ayse.kaya");
      expect.unreachable("assertPassword should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(PasswordPolicyError);
      expect((error as PasswordPolicyError).status).toBe(400);
      expect((error as PasswordPolicyError).violations).toContain("too_short");
    }
  });
});

describe("bcrypt hasher", () => {
  it("round-trips a password and refuses the wrong one", async () => {
    const hasher = new BcryptPasswordHasher(4);
    const stored = await hasher.hash("Maestro!Test-2026");

    expect(stored).not.toContain("Maestro");
    expect(await hasher.verify("Maestro!Test-2026", stored)).toBe(true);
    expect(await hasher.verify("Maestro!Test-2027", stored)).toBe(false);
  });

  it("salts, so the same password hashes differently twice", async () => {
    const hasher = new BcryptPasswordHasher(4);
    expect(await hasher.hash("Maestro!Test-2026")).not.toBe(await hasher.hash("Maestro!Test-2026"));
  });

  it("burns a comparison when there is no account, without throwing", async () => {
    await expect(new BcryptPasswordHasher(4).burn()).resolves.toBeUndefined();
  });
});

describe("local identity provider", () => {
  it("enforces the policy when an account is provisioned, not at login", async () => {
    const provider = new LocalIdentityProvider(new InMemoryUserDirectory(), new BcryptPasswordHasher(4));

    await expect(
      provider.provision({
        username: "ayse.kaya",
        userId: "ayse.kaya@ugurbank.local",
        password: "kisa",
        groups: [],
        roles: [],
      }),
    ).rejects.toBeInstanceOf(PasswordPolicyError);
  });

  it("normalises the username on both sides", async () => {
    const users = new InMemoryUserDirectory();
    const provider = new LocalIdentityProvider(users, new BcryptPasswordHasher(4));
    await provider.provision({
      username: "  Ayse.Kaya  ",
      userId: "ayse.kaya@ugurbank.local",
      password: "Maestro!Test-2026",
      groups: ["tech-leads"],
      roles: [],
    });

    const user = await provider.authenticate("AYSE.KAYA", "Maestro!Test-2026");

    expect(user).toMatchObject({ userId: "ayse.kaya@ugurbank.local", groups: ["tech-leads"] });
  });

  it("never stores the plaintext password", async () => {
    const users = new InMemoryUserDirectory();
    const provider = new LocalIdentityProvider(users, new BcryptPasswordHasher(4));
    await provider.provision({
      username: "ayse.kaya",
      userId: "ayse.kaya@ugurbank.local",
      password: "Maestro!Test-2026",
      groups: [],
      roles: [],
    });

    const record = await users.find("ayse.kaya");
    expect(record?.passwordHash).not.toContain("Maestro");
    expect(record?.passwordHash.startsWith("$2")).toBe(true);
  });
});
