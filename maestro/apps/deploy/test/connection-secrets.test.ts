import { describe, expect, it } from "vitest";
import type { SecretPort } from "@maestro/ports";
import {
  ConnectionSecretPort,
  type ConnectionCredentialRow,
} from "../src/stores/connection-secrets.js";

/**
 * The panel is where connector credentials are entered — and now also where a
 * RUN reads them from.
 *
 * These tests pin the four decisions that make that safe, because each one is a
 * place where a plausible alternative produces a silent failure:
 *
 *   precedence  — a connection outranks `.env`, and the loser is announced
 *   freshness   — a token changed in the panel is live with no restart
 *   fall-through— an install with no connection resolves exactly as before
 *   boundary    — writes never reach the connection store
 */

/** The deployment's own SecretPort, as `.env`/Vault would answer. */
function envPort(values: Record<string, string>): SecretPort {
  return {
    get: (key) =>
      key in values
        ? Promise.resolve(values[key]!)
        : Promise.reject(new Error(`secret "${key}" not found`)),
    set: () => Promise.reject(new Error("env-file secrets are read-only")),
    issueShortLived: () => Promise.reject(new Error("no short-lived credentials")),
  };
}

/** The `EncryptedSecretStore`, as the panel's enciphered slots would answer. */
function connectorPort(slots: Record<string, string>): SecretPort {
  return {
    get: (ref) =>
      ref in slots
        ? Promise.resolve(slots[ref]!)
        : Promise.reject(new Error(`no secret stored under "${ref}"`)),
    set: () => Promise.reject(new Error("not used in these tests")),
    issueShortLived: () => Promise.reject(new Error("not used in these tests")),
  };
}

function connections(rows: ConnectionCredentialRow[]): {
  findMany: () => Promise<ConnectionCredentialRow[]>;
} {
  return { findMany: () => Promise.resolve(rows) };
}

const jiraRow: ConnectionCredentialRow = {
  id: "jira",
  kind: "jira_cloud",
  secretRef: "connector:jira:abc123",
  enabled: true,
};

describe("ConnectionSecretPort", () => {
  it("serves the token an admin entered in the panel, not the one in .env", async () => {
    const lines: string[] = [];
    const port = new ConnectionSecretPort({
      connections: connections([jiraRow]),
      connectorSecrets: connectorPort({ "connector:jira:abc123": "panelden-girilen" }),
      fallback: envPort({ "kv/jira#token": "env-dosyasindaki" }),
      log: (message) => lines.push(message),
    });

    // THE WHOLE POINT: before this existed the answer here was the env value,
    // and the panel's token — stored, tested, shown green — was never used by
    // any run.
    await expect(port.get("kv/jira#token")).resolves.toBe("panelden-girilen");
  });

  it("names the .env value it is shadowing, once, rather than overriding it silently", async () => {
    const lines: string[] = [];
    const port = new ConnectionSecretPort({
      connections: connections([jiraRow]),
      connectorSecrets: connectorPort({ "connector:jira:abc123": "panelden-girilen" }),
      fallback: envPort({ "kv/jira#token": "env-dosyasindaki" }),
      log: (message) => lines.push(message),
    });

    await port.get("kv/jira#token");
    await port.get("kv/jira#token");
    await port.get("kv/jira#token");

    // Once per reference, not once per call: this resolves on every outbound
    // request, and a per-call line would bury the thing it is trying to say.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("kv/jira#token");
    expect(lines[0]).toContain(".env");
  });

  it("says nothing when the environment held no value to shadow", async () => {
    const lines: string[] = [];
    const port = new ConnectionSecretPort({
      connections: connections([jiraRow]),
      connectorSecrets: connectorPort({ "connector:jira:abc123": "panelden-girilen" }),
      fallback: envPort({}),
      log: (message) => lines.push(message),
    });

    await port.get("kv/jira#token");
    // The target state — a stack configured entirely from the panel. There is
    // no conflict here, so a warning would be noise that trains an operator to
    // ignore the line that does matter.
    expect(lines).toEqual([]);
  });

  it("takes a rotated token on the next call, with no restart", async () => {
    const slots: Record<string, string> = { "connector:jira:abc123": "eski-jeton" };
    const rows: ConnectionCredentialRow[] = [{ ...jiraRow }];
    const port = new ConnectionSecretPort({
      connections: { findMany: () => Promise.resolve(rows) },
      connectorSecrets: connectorPort(slots),
      fallback: envPort({}),
      log: () => {},
    });

    await expect(port.get("kv/jira#token")).resolves.toBe("eski-jeton");

    // What the panel does on a token replacement: a NEW slot, and the row now
    // points at it (`storeToken` rotates the ref rather than overwriting).
    slots["connector:jira:def456"] = "yeni-jeton";
    rows[0] = { ...jiraRow, secretRef: "connector:jira:def456" };

    // No restart, no cache to invalidate: the drivers resolve this thunk on
    // every request, so the next Jira call already uses the new credential.
    await expect(port.get("kv/jira#token")).resolves.toBe("yeni-jeton");
  });

  it("falls through to .env when no connection has been created yet", async () => {
    const port = new ConnectionSecretPort({
      connections: connections([]),
      connectorSecrets: connectorPort({}),
      fallback: envPort({ "kv/jira#token": "env-dosyasindaki" }),
      log: () => {},
    });

    // The install that has not adopted the panel yet must behave EXACTLY as it
    // did before this seam existed — that is what makes it safe to switch on
    // for a stack already running.
    await expect(port.get("kv/jira#token")).resolves.toBe("env-dosyasindaki");
  });

  it("ignores a disabled connection and one with no token", async () => {
    const disabled = new ConnectionSecretPort({
      connections: connections([{ ...jiraRow, enabled: false }]),
      connectorSecrets: connectorPort({ "connector:jira:abc123": "panelden-girilen" }),
      fallback: envPort({ "kv/jira#token": "env-dosyasindaki" }),
      log: () => {},
    });
    await expect(disabled.get("kv/jira#token")).resolves.toBe("env-dosyasindaki");

    const tokenless = new ConnectionSecretPort({
      connections: connections([{ ...jiraRow, secretRef: null }]),
      connectorSecrets: connectorPort({}),
      fallback: envPort({ "kv/jira#token": "env-dosyasindaki" }),
      log: () => {},
    });
    await expect(tokenless.get("kv/jira#token")).resolves.toBe("env-dosyasindaki");
  });

  it("leaves references no connection kind owns to the deployment's port", async () => {
    const port = new ConnectionSecretPort({
      connections: connections([jiraRow]),
      connectorSecrets: connectorPort({ "connector:jira:abc123": "panelden-girilen" }),
      fallback: envPort({
        "kv/jira#webhook": "webhook-sirri",
        "kv/ldap#service-password": "ldap-parolasi",
      }),
      log: () => {},
    });

    // The webhook secret and the LDAP bind password are deployment facts no
    // connection claims; a composite that answered for them would be inventing
    // authority it was never given.
    await expect(port.get("kv/jira#webhook")).resolves.toBe("webhook-sirri");
    await expect(port.get("kv/ldap#service-password")).resolves.toBe("ldap-parolasi");
  });

  it("routes a Data Center connection to the same Jira reference as Cloud", async () => {
    const port = new ConnectionSecretPort({
      connections: connections([{ ...jiraRow, kind: "jira_dc" }]),
      connectorSecrets: connectorPort({ "connector:jira:abc123": "dc-pat" }),
      fallback: envPort({}),
      log: () => {},
    });
    // A deployment speaks to exactly one Jira (`assertOneJiraInstance`), so
    // whichever kind the operator created is the one this install talks to.
    await expect(port.get("kv/jira#token")).resolves.toBe("dc-pat");
  });

  it("falls back to .env when the stored token will not decrypt", async () => {
    const port = new ConnectionSecretPort({
      connections: connections([jiraRow]),
      // The slot is gone or was enciphered under a different master key — what a
      // restored backup without CONNECTOR_MASTER_KEY looks like.
      connectorSecrets: connectorPort({}),
      fallback: envPort({ "kv/jira#token": "env-dosyasindaki" }),
      log: () => {},
    });

    // Conservative on purpose: rotating the master key must not take down a
    // stack that still has a working .env credential.
    await expect(port.get("kv/jira#token")).resolves.toBe("env-dosyasindaki");
  });

  it("survives an unreachable database rather than failing the lookup", async () => {
    const port = new ConnectionSecretPort({
      connections: { findMany: () => Promise.reject(new Error("connection refused")) },
      connectorSecrets: connectorPort({}),
      fallback: envPort({ "kv/jira#token": "env-dosyasindaki" }),
      log: () => {},
    });
    await expect(port.get("kv/jira#token")).resolves.toBe("env-dosyasindaki");
  });

  it("never writes into a connection — set and issueShortLived stay with the deployment", async () => {
    const written: string[] = [];
    const port = new ConnectionSecretPort({
      connections: connections([jiraRow]),
      connectorSecrets: {
        get: () => Promise.reject(new Error("must not be consulted for a write")),
        set: () => {
          written.push("connector");
          return Promise.resolve();
        },
        issueShortLived: () => Promise.reject(new Error("must not be consulted")),
      },
      fallback: {
        get: () => Promise.reject(new Error("unused")),
        set: () => {
          written.push("deployment");
          return Promise.resolve();
        },
        issueShortLived: () =>
          Promise.resolve({ secret: "kisa-omurlu", expiresAt: "2026-01-01T00:00:00.000Z" }),
      },
      log: () => {},
    });

    // The boundary `bin/bff.ts` documents: a console writes to the connector
    // store, and must not be able to rewrite the mount an operator manages.
    // This composite only ever READS a connection.
    await port.set("kv/jira#token", "yeni");
    expect(written).toEqual(["deployment"]);

    // A short-lived push credential (M31) is MINTED, not stored: a long-lived
    // connection token cannot serve the same purpose, and answering one with
    // the other would hand out a permanent credential where a scoped, expiring
    // one was required.
    await expect(port.issueShortLived("git/push", 300)).resolves.toMatchObject({
      secret: "kisa-omurlu",
    });
  });
});
