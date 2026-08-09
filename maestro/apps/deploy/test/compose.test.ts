import { describe, expect, it } from "vitest";
import { bootPlatform } from "../src/boot.js";
import { assertAllPortsPresent, CompositionError, describeWiring, workerSelection } from "../src/compose.js";
import { storageConfig } from "../src/driver-config.js";
import { loadDeployEnv, vaultMounts } from "../src/env.js";
import { ALL_PORT_KEYS, driversFor, WORKER_PORT_KEYS } from "../src/profile.js";
import { buildSecretPort } from "../src/secrets.js";
import { DEV_ENV, envWithout, OFFLINE_SQL, PROD_ENV } from "./fixtures.js";

/**
 * These tests boot the REAL composition root against the REAL driver packages.
 * Nothing is stubbed except the two collaborators a process must own (the SQL
 * executor and, in the prod profile, the S3 key material): if a driver's config
 * schema changes under us, these fail — which is the entire point of wiring
 * tests that do not use fakes.
 */

async function boot(source: Record<string, string | undefined>) {
  return bootPlatform({ source, sql: OFFLINE_SQL, quiet: true });
}

describe("composition root: dev profile", () => {
  it("fills every port with a real driver instance", async () => {
    const { deployment } = await boot({ ...DEV_ENV });

    // Not "no error was thrown" — every port is an object with methods on it.
    for (const key of ALL_PORT_KEYS) {
      const port =
        key === "ci"
          ? deployment.ci
          : (deployment.ports as unknown as Record<string, unknown>)[
              key === "secret" ? "secrets" : key
            ];
      expect(port, `port ${key}`).toBeTypeOf("object");
      expect(port, `port ${key}`).not.toBeNull();
    }
  });

  it("exposes the port→driver table the dev profile promises", async () => {
    const { deployment } = await boot({ ...DEV_ENV });
    const table = Object.fromEntries(
      describeWiring(deployment.selection).map(({ port, driver }) => [port, driver]),
    );

    expect(table).toEqual({
      work: "jira-dc",
      scm: "ado",
      ci: "ado",
      llm: "gateway",
      scan: "trivy",
      storage: "pg-blob",
      secret: "env-file",
      notify: "jira",
      publish: "jira",
    });
  });

  it("resolves ports that actually carry their interface's methods", async () => {
    const { deployment } = await boot({ ...DEV_ENV });

    // A registered factory could return an object with nothing on it and
    // `assertAllPortsPresent` would pass it. These are the methods the
    // workflow activities call, checked against the live instances.
    expect(deployment.ports.work.verifyWebhook).toBeTypeOf("function");
    expect(deployment.ports.work.addComment).toBeTypeOf("function");
    expect(deployment.ports.secrets.get).toBeTypeOf("function");
    expect(deployment.ports.secrets.issueShortLived).toBeTypeOf("function");
    expect(deployment.ports.storage.put).toBeTypeOf("function");
    expect(deployment.ports.storage.presign).toBeTypeOf("function");
    expect(deployment.ports.llm.generateObject).toBeTypeOf("function");
    expect(deployment.ports.llm.agentSession).toBeTypeOf("function");
    expect(deployment.ports.notify.send).toBeTypeOf("function");
    expect(deployment.ports.scm.openPr).toBeTypeOf("function");
    expect(deployment.ports.scm.getPushCredential).toBeTypeOf("function");
    expect(deployment.ports.publish.publish).toBeTypeOf("function");
    expect(deployment.ci.parseBuildEvent).toBeTypeOf("function");
  });

  it("hands the worker exactly the eight ports it knows, without ci", async () => {
    const { deployment } = await boot({ ...DEV_ENV });
    const selection = workerSelection(deployment.selection);

    expect(Object.keys(selection).sort()).toEqual([...WORKER_PORT_KEYS].sort());
    expect(selection).not.toHaveProperty("ci");
  });
});

describe("composition root: prod profile", () => {
  it("names the bank drivers, not the dev ones", () => {
    const env = loadDeployEnv({ ...PROD_ENV });
    const table = Object.fromEntries(
      ALL_PORT_KEYS.map((port) => [port, driversFor(env.profile)[port]]),
    );

    expect(table["secret"]).toBe("vault");
    expect(table["storage"]).toBe("s3-compat");
    expect(table["notify"]).toBe("multi");
    expect(table["publish"]).toBe("multi");
  });

  it("builds a real Vault secret port from the AppRole", () => {
    const env = loadDeployEnv({ ...PROD_ENV });
    const secrets = buildSecretPort(env);

    expect(secrets.get).toBeTypeOf("function");
    expect(secrets.issueShortLived).toBeTypeOf("function");
  });

  it("refuses to build the s3-compat storage port without key material", () => {
    const env = loadDeployEnv({ ...PROD_ENV });
    // The prod storage driver signs requests with the key itself, so composing
    // it without one must fail rather than produce a port that 403s later.
    expect(() => storageConfig(env, "prod")).toThrow(/credential/i);
  });

  it("keeps the git mount in the allow-list so push credentials can be issued", () => {
    const env = loadDeployEnv({ ...PROD_ENV });
    // A mount list without `git` composes fine and then denies every push at
    // the first engineering turn (M31) — the driver rejects it at build time.
    expect(vaultMounts(env)).toContain("git");
  });
});

describe("composition root: fail-closed", () => {
  it.each([
    ["DATABASE_URL", "production"],
    ["TEMPORAL_ADDRESS", "production"],
  ])("refuses to boot in production without %s", async (missing) => {
    await expect(
      boot({ ...envWithout(DEV_ENV, missing), NODE_ENV: "production", MAESTRO_PROFILE: "prod" }),
    ).rejects.toThrow(missing);
  });

  it("refuses when the ADO organisation is unset", async () => {
    await expect(boot(envWithout(DEV_ENV, "ADO_ORG"))).rejects.toThrow(/ADO_ORG/);
  });

  it("refuses when the CI allow-list is empty rather than allowing every pipeline", async () => {
    await expect(boot(envWithout(DEV_ENV, "ADO_PR_VALIDATION_BUILDS"))).rejects.toThrow(
      /ADO_PR_VALIDATION_BUILDS/,
    );
  });

  it("refuses a malformed CI allow-list entry instead of skipping it", async () => {
    await expect(boot({ ...DEV_ENV, ADO_PR_VALIDATION_BUILDS: "core-api:not-a-number" })).rejects.toThrow(
      /repo:definitionId/,
    );
  });

  it("refuses when the LLM endpoint is unset", async () => {
    await expect(boot(envWithout(DEV_ENV, "LLM_BASE_URL"))).rejects.toThrow(/LLM_BASE_URL/);
  });

  it("names the port that failed to build", async () => {
    // A bad Jira base URL must not surface as a bare "invalid url".
    await expect(boot({ ...DEV_ENV, JIRA_BASE_URL: "not-a-url" })).rejects.toThrow(/JIRA_BASE_URL/);
  });

  it("refuses the dev profile under NODE_ENV=production", async () => {
    await expect(boot({ ...DEV_ENV, NODE_ENV: "production" })).rejects.toThrow(/dev/);
  });

  it("refuses an unknown profile, naming the ones that exist", async () => {
    await expect(boot({ ...DEV_ENV, MAESTRO_PROFILE: "staging" })).rejects.toThrow(/prod, dev/);
  });

  it("refuses the prod profile without a Vault AppRole", async () => {
    await expect(
      boot({ ...DEV_ENV, MAESTRO_PROFILE: "prod", NODE_ENV: "development" }),
    ).rejects.toThrow(/VAULT_ROLE_ID/);
  });
});

describe("assertAllPortsPresent", () => {
  it("rejects a bundle whose port resolved to nothing", () => {
    const bundle = Object.fromEntries(
      WORKER_PORT_KEYS.map((key) => [key === "secret" ? "secrets" : key, {}]),
    ) as never;
    expect(() => assertAllPortsPresent({ ...(bundle as object), storage: undefined } as never, {} as never))
      .toThrow(CompositionError);
  });

  it("accepts a bundle where every port is an object", () => {
    const bundle = Object.fromEntries(
      WORKER_PORT_KEYS.map((key) => [key === "secret" ? "secrets" : key, {}]),
    ) as never;
    expect(() => assertAllPortsPresent(bundle, {} as never)).not.toThrow();
  });
});
