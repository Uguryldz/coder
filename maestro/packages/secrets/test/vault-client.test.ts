import { describe, expect, it } from "vitest";
import {
  SecretConfigError,
  SecretPermissionDeniedError,
  VaultClient,
  VaultConfig,
  VaultHttpError,
  VaultResponseError,
  VaultSealedError,
} from "../src/index.js";
import { APPROLE, fakeClock, fixture, stubFetch, T0, VAULT_CONFIG, withLogin } from "./helpers.js";

const config = VaultConfig.parse(VAULT_CONFIG);

function client(responses: Parameters<typeof stubFetch>[0], clock = fakeClock()) {
  const stub = stubFetch(responses);
  return {
    stub,
    clock,
    vault: new VaultClient({ config, approle: APPROLE, fetchImpl: stub.fetchImpl, clock: clock.clock }),
  };
}

/** A recorded login response with `renewable` flipped — same shape, other flag. */
function nonRenewableLogin(): unknown {
  const body = structuredClone(fixture("approle-login")) as { auth: Record<string, unknown> };
  body.auth["renewable"] = false;
  return body;
}

describe("VaultClient AppRole login", () => {
  it("logs in on first use and sends role_id/secret_id to the approle mount", async () => {
    const { stub, vault } = client(withLogin([{ body: fixture("kv-read") }]));

    await vault.read("kv/data/jira/pat", "read");

    expect(stub.calls[0]!.method).toBe("POST");
    expect(stub.calls[0]!.url).toBe("https://vault.internal.bank/v1/auth/approle/login");
    expect(stub.calls[0]!.body).toEqual({ role_id: APPROLE.roleId, secret_id: APPROLE.secretId });
    expect(stub.calls[0]!.headers["x-vault-token"]).toBeUndefined();
  });

  it("carries the issued client token on subsequent reads", async () => {
    const { stub, vault } = client(withLogin([{ body: fixture("kv-read") }]));

    await vault.read("kv/data/jira/pat", "read");

    expect(stub.calls[1]!.headers["x-vault-token"]).toBe("hvs.CAESIJ-MAESTRO-CLIENT-TOKEN");
  });

  it("sends the enterprise namespace header when configured", async () => {
    const stub = stubFetch(withLogin([{ body: fixture("kv-read") }]));
    const vault = new VaultClient({
      config: VaultConfig.parse({ ...VAULT_CONFIG, namespace: "bank/sdlc" }),
      approle: APPROLE,
      fetchImpl: stub.fetchImpl,
      clock: fakeClock().clock,
    });

    await vault.read("kv/data/jira/pat", "read");

    expect(stub.calls[0]!.headers["x-vault-namespace"]).toBe("bank/sdlc");
  });

  it("reuses a valid token instead of logging in again", async () => {
    const { stub, vault } = client(withLogin([{ body: fixture("kv-read") }, { body: fixture("kv-read") }]));

    await vault.read("kv/data/jira/pat", "read");
    await vault.read("kv/data/jira/pat", "read");

    expect(stub.calls.filter((c) => c.url.endsWith("/login"))).toHaveLength(1);
  });

  it("logs in exactly once for concurrent reads (single flight)", async () => {
    const { stub, vault } = client(withLogin([{ body: fixture("kv-read") }, { body: fixture("kv-read") }]));

    await Promise.all([vault.read("kv/data/jira/pat", "read"), vault.read("kv/data/jira/pat", "read")]);

    expect(stub.calls.filter((c) => c.url.endsWith("/login"))).toHaveLength(1);
  });

  it("tracks the lease and exposes its deadline", async () => {
    const { vault } = client(withLogin([{ body: fixture("kv-read") }]));

    await vault.read("kv/data/jira/pat", "read");

    expect(vault.tokenExpiresAtMs()).toBe(T0 + 3_600_000);
  });

  it("rejects a login response without a usable lease", async () => {
    const { vault } = client([{ body: { auth: { client_token: "hvs.X", lease_duration: 0 } } }]);

    await expect(vault.read("kv/data/jira/pat", "read")).rejects.toBeInstanceOf(VaultResponseError);
  });

  it("maps a rejected AppRole login to a permission error", async () => {
    const { vault } = client([{ status: 403, body: fixture("error-permission-denied") }]);

    await expect(vault.read("kv/data/jira/pat", "read")).rejects.toBeInstanceOf(SecretPermissionDeniedError);
  });
});

describe("VaultClient token renewal", () => {
  it("renews before the lease expires instead of logging in again", async () => {
    const clock = fakeClock();
    const { stub, vault } = client(
      withLogin([{ body: fixture("kv-read") }, { body: fixture("token-renew") }, { body: fixture("kv-read") }]),
      clock,
    );

    await vault.read("kv/data/jira/pat", "read");
    clock.advance(3_600_000 - 60_000); // inside the renew skew window
    await vault.read("kv/data/jira/pat", "read");

    expect(stub.calls.map((c) => c.url)).toContain("https://vault.internal.bank/v1/auth/token/renew-self");
    expect(stub.calls.filter((c) => c.url.endsWith("/login"))).toHaveLength(1);
    expect(vault.tokenExpiresAtMs()).toBe(T0 + 3_540_000 + 3_600_000);
  });

  it("falls back to a fresh login when renewal is refused", async () => {
    const clock = fakeClock();
    const { stub, vault } = client(
      withLogin([
        { body: fixture("kv-read") },
        { status: 403, body: fixture("error-permission-denied") },
        { body: fixture("approle-login") },
        { body: fixture("kv-read") },
      ]),
      clock,
    );

    await vault.read("kv/data/jira/pat", "read");
    clock.advance(3_600_000);
    await vault.read("kv/data/jira/pat", "read");

    expect(stub.calls.filter((c) => c.url.endsWith("/login"))).toHaveLength(2);
  });

  it("logs in again when the token is not renewable", async () => {
    const clock = fakeClock();
    const { stub, vault } = client(
      [
        { body: nonRenewableLogin() },
        { body: fixture("kv-read") },
        { body: nonRenewableLogin() },
        { body: fixture("kv-read") },
      ],
      clock,
    );

    await vault.read("kv/data/jira/pat", "read");
    clock.advance(3_600_000);
    await vault.read("kv/data/jira/pat", "read");

    expect(stub.calls.filter((c) => c.url.endsWith("/renew-self"))).toHaveLength(0);
    expect(stub.calls.filter((c) => c.url.endsWith("/login"))).toHaveLength(2);
  });
});

describe("VaultClient read outcomes", () => {
  it("returns the parsed body on 200", async () => {
    const { vault } = client(withLogin([{ body: fixture("kv-read") }]));

    const result = await vault.read("kv/data/jira/pat", "read");

    expect(result).toEqual({ ok: true, body: fixture("kv-read") });
  });

  it("appends query parameters", async () => {
    const { stub, vault } = client(withLogin([{ body: fixture("dynamic-creds") }]));

    await vault.read("git/creds/repo/x/push", "issue", { ttl: "600s" });

    expect(stub.calls[1]!.url).toBe("https://vault.internal.bank/v1/git/creds/repo/x/push?ttl=600s");
  });

  it("reports 403 as denied and 404 as not found — not as exceptions", async () => {
    const { vault } = client(
      withLogin([
        { status: 403, body: fixture("error-permission-denied") },
        { status: 404, body: fixture("kv-deleted") },
      ]),
    );

    expect(await vault.read("kv/data/a/b", "read")).toEqual({ ok: false, kind: "denied" });
    expect(await vault.read("kv/data/a/b", "read")).toEqual({ ok: false, kind: "not_found" });
  });

  it.each([
    [503, VaultSealedError],
    [501, VaultSealedError],
    [500, VaultHttpError],
    [429, VaultHttpError],
  ])("throws a typed error for HTTP %i", async (status, expected) => {
    const { vault } = client(withLogin([{ status, body: fixture("error-sealed") }]));

    await expect(vault.read("kv/data/a/b", "read")).rejects.toBeInstanceOf(expected);
  });

  it("rejects a non-JSON body rather than guessing", async () => {
    const { vault } = client(withLogin([{ text: "<html>proxy error</html>" }]));

    await expect(vault.read("kv/data/a/b", "read")).rejects.toBeInstanceOf(VaultResponseError);
  });

  it("rejects an empty 200 body", async () => {
    const { vault } = client(withLogin([{ text: "  " }]));

    await expect(vault.read("kv/data/a/b", "read")).rejects.toBeInstanceOf(VaultResponseError);
  });
});

describe("VaultClient construction", () => {
  it("refuses to build without AppRole material (M6)", () => {
    const stub = stubFetch([]);
    expect(
      () => new VaultClient({ config, approle: { roleId: "", secretId: "x" }, fetchImpl: stub.fetchImpl }),
    ).toThrow(SecretConfigError);
  });
});
