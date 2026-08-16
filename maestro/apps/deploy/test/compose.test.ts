import { createJiraCloudWorkPort } from "@maestro/adapter-jira";
import { MaestroPublishPort } from "@maestro/publish";
import { createPgBlobStorage, ObjectLockNotConfiguredError } from "@maestro/storage";
import { describe, expect, it } from "vitest";
import { bootPlatform } from "../src/boot.js";
import { assertAllPortsPresent, CompositionError, describeWiring, workerSelection } from "../src/compose.js";
import { storageConfig } from "../src/driver-config.js";
import { loadDeployEnv, vaultMounts } from "../src/env.js";
import { ALL_PORT_KEYS, driversFor, WORKER_PORT_KEYS } from "../src/profile.js";
import { buildSecretPort } from "../src/secrets.js";
import { docAttacherFor } from "../src/stores/doc-attacher.js";
import { statusMoverFor } from "../src/stores/status-mover.js";
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
      // `multi`, not `jira`: the analysis deliverable is a Word/PDF as well as
      // a comment (M103r), and a port composed for the `jira` target alone
      // answered the delivery step's request for a file with
      // `CapabilityNotSupportedError`. See `publishConfig`.
      publish: "multi",
    });
  });

  /**
   * M103r. The analysis Word/PDF only exist if the publish port was COMPOSED
   * to serve them — `MaestroPublishPort` refuses a target it has no publisher
   * for, so a port built for `jira` alone makes the delivery step's document
   * request fail at run time, on a ticket, every time.
   *
   * This asserts against the real port built by the real registry, so a
   * missing storage sink (which `registerPublishDrivers` refuses at
   * composition) fails here rather than in front of an analyst.
   */
  it("composes a publish port that can actually serve docx and pdf (M103r)", async () => {
    const { deployment } = await boot({ ...DEV_ENV });
    // The concrete port, not the `PublishPort` interface: `targets()` is what
    // says which publishers were actually BUILT, which is the fact under test.
    const publish = deployment.ports.publish;
    expect(publish).toBeInstanceOf(MaestroPublishPort);
    expect((publish as MaestroPublishPort).targets()).toEqual(
      expect.arrayContaining(["jira", "docx", "pdf"]),
    );
  });

  /**
   * M56/M57, and the reason a finished analysis attached NOTHING to a live
   * ticket (OPS-42, OPS-49): the composed storage port had no `objectLock`
   * configuration, the `docx` target asks for a locked put, and the driver
   * refused it rather than storing an unprotected record. The refusal was
   * correct; the missing configuration was the defect.
   *
   * Asserted against the REAL driver over a recording executor, so it proves
   * the row is written WITH retention — not merely that a config key exists.
   */
  it("composes a storage port that can actually honour a locked put (M56/M57)", async () => {
    const writes: { sql: string; params: readonly unknown[] }[] = [];
    const recordingSql = {
      query: (sql: string, params: readonly unknown[] = []) => {
        if (sql.startsWith("INSERT")) writes.push({ sql, params });
        return Promise.resolve([]);
      },
    };
    const { deployment } = await bootPlatform({
      source: { ...DEV_ENV },
      sql: recordingSql,
      quiet: true,
    });

    const before = Date.now();
    await deployment.ports.storage.put("evidence/OPS-49/analiz.docx", new Uint8Array([1, 2, 3]), {
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      objectLock: true,
    });

    // The put reached the table AND carried retention: `object_lock` true and a
    // `retain_until` ten years out. Before the fix this call threw instead.
    expect(writes).toHaveLength(1);
    const params = writes[0]?.params ?? [];
    expect(params[4], "object_lock column").toBe(true);
    const retainUntil = new Date(String(params[5])).getTime();
    const expected = new Date(before).setUTCFullYear(new Date(before).getUTCFullYear() + 10);
    // Same calendar day; the clock advances a few ms between the two readings.
    expect(Math.abs(retainUntil - expected)).toBeLessThan(60_000);
  });

  /**
   * The other half, and the one that must NOT be "fixed": a driver built with
   * no retention configuration still REFUSES a locked put. If this ever starts
   * passing silently, the platform has begun writing records it tells the
   * evidence package are WORM-protected while they are deletable.
   */
  it("still refuses a locked put when objectLock is unconfigured (M57 fail-closed)", async () => {
    const unconfigured = createPgBlobStorage(
      { table: "storage_blob" },
      { sql: OFFLINE_SQL as never },
    );

    await expect(
      unconfigured.put("evidence/OPS-49/analiz.docx", new Uint8Array([1]), { objectLock: true }),
    ).rejects.toThrow(ObjectLockNotConfiguredError);

    // An UNLOCKED put through the same driver still works — the refusal is
    // scoped to the request that asked for protection, not a dead driver.
    await expect(
      unconfigured.put("scratch/note.txt", new Uint8Array([1])),
    ).resolves.toBeUndefined();
  });

  /**
   * The prod profile signs with S3's own Object Lock rather than emulating it,
   * so the config must carry the same retention the pg-blob driver applies —
   * a deployment that locks for ten years in dev and not at all in prod is the
   * exact "works in dev, silently broken in prod" failure this asserts against.
   */
  it("configures the same retention on the prod s3-compat driver (M56/M57)", () => {
    const env = loadDeployEnv({ ...PROD_ENV });
    const config = storageConfig(env, "prod", {
      accessKeyId: "AKIA_TEST",
      secretAccessKey: "secret",
    });

    expect(config["objectLock"]).toEqual({ mode: "COMPLIANCE", years: 10 });
  });

  /**
   * M103r/M44. The core declares the SHAPE (`DocAttacher`); this is where it
   * is matched to a driver. Asserted against the REAL drivers rather than
   * stubs, because the whole risk is that the concrete Cloud port stops
   * carrying `addAttachment` and the seam silently becomes `undefined` — which
   * would read, on a live ticket, as "this deployment cannot attach files".
   */
  it("gives the worker a doc attacher only when the work driver can carry a file", async () => {
    // Data Center: no attachment endpoint on the driver, so no seam. The
    // documents are still generated and stored; the journal says they did not
    // reach the ticket, which is honest rather than a stub that throws.
    const dc = await boot({ ...DEV_ENV });
    expect(driversFor("dev").work).toBe("jira-dc");
    expect(docAttacherFor(dc.deployment.ports.work)).toBeUndefined();

    // Cloud — the driver the `analiz` profile runs on: `addAttachment` exists,
    // so the seam is wired and the analysis Word/PDF land on the ticket.
    const cloud = createJiraCloudWorkPort({
      baseUrl: "https://jira.invalid",
      email: "maestro-bot@bank.invalid",
      apiTokenRef: "kv/jira#token",
      deps: { secrets: buildSecretPort(loadDeployEnv(DEV_ENV)) },
    });
    expect(driversFor("analiz").work).toBe("jira-cloud");
    const attacher = docAttacherFor(cloud);
    expect(attacher).toBeDefined();
    expect(typeof attacher?.addAttachment).toBe("function");
  });

  /**
   * The listening rule's status map, wired the same way and at the same risk:
   * if the concrete Cloud port stops carrying `transitionToStatus`, the seam
   * silently becomes `undefined` and every mapped run degrades to comment-only
   * mode — the exact behaviour operators configured the map to get away from.
   */
  it("gives the worker a status mover only when the work driver can transition", async () => {
    // Data Center: no transition-by-name capability, so no seam. M102 — the
    // driver has no workflow permissions there, and progress is a label.
    const dc = await boot({ ...DEV_ENV });
    expect(statusMoverFor(dc.deployment.ports.work)).toBeUndefined();

    const cloud = createJiraCloudWorkPort({
      baseUrl: "https://jira.invalid",
      email: "maestro-bot@bank.invalid",
      apiTokenRef: "kv/jira#token",
      deps: { secrets: buildSecretPort(loadDeployEnv(DEV_ENV)) },
    });
    const mover = statusMoverFor(cloud);
    expect(mover).toBeDefined();
    expect(typeof mover?.move).toBe("function");
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
