import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { bankaComposePath, bankaEnvExamplePath, bankaInstallPath } from "./paths.js";

/**
 * The bank bundle (`deploy/banka/`), checked as data.
 *
 * This is a DIFFERENT artefact from `deploy/compose.yaml` and needs its own
 * guards: it builds nothing, it is carried into an air-gapped site on a USB
 * stick, and the person who runs it cannot read the source to work out why it
 * refused. Everything asserted here is a defect a full installation rehearsal
 * actually hit — each one produced a stack that either would not install or
 * would install over somebody else's data.
 */

interface ComposeService {
  container_name?: string;
  image?: string;
  ports?: string[];
}

const composeText = readFileSync(bankaComposePath(), "utf8");
const compose = parse(composeText, { merge: true }) as {
  name?: string;
  services: Record<string, ComposeService>;
};
const envExample = readFileSync(bankaEnvExamplePath(), "utf8");
const install = readFileSync(bankaInstallPath(), "utf8");

/**
 * Two installations on one host.
 *
 * The bundle used to pin `name: maestro` and a fixed `container_name:` on every
 * service. Both are GLOBAL to the docker daemon, so a second installation —
 * an acceptance environment, or a rehearsal of the next release — did not
 * become a second stack. It resolved to the SAME project and therefore the same
 * `maestro_postgres-data` volume as the running one, and compose treated it as
 * an update of production rather than as a new install.
 *
 * Nothing warned: `install.sh` prints "KURULUM TAMAM" either way.
 */
describe("banka bundle: two installations must not collide", () => {
  it("takes the stack name from the environment instead of pinning it", () => {
    // Pinned, `-p` is the only escape and `install.sh` never passes one.
    expect(compose.name).toBe("${COMPOSE_PROJECT_NAME:-maestro}");
  });

  it("keeps the single-install default, so an existing site sees no change", () => {
    expect(compose.name).toContain(":-maestro}");
  });

  it("pins no container_name, because that name is global to the daemon", () => {
    // A project name scopes volumes and networks but NOT container_name: two
    // stacks with `container_name: maestro-bff` cannot both exist, whatever
    // `-p` says.
    for (const [service, definition] of Object.entries(compose.services)) {
      expect(definition.container_name, `${service} pins a global container_name`).toBeUndefined();
    }
  });

  it("documents the second-install hazard where the operator sets the name", () => {
    expect(envExample).toContain("COMPOSE_PROJECT_NAME");
  });

  it("never looks a container up by a hard-coded name", () => {
    // With container_name gone the real names carry the project prefix
    // (`maestro-bff-1`, `kabul-bff-1`). A `docker inspect maestro-bff` here
    // fails silently — the `|| echo ""` swallows it — and the installer then
    // reports a healthy stack as "not ready" after waiting 150 seconds.
    // Comment lines are excluded: the fix's own rationale names the old call.
    const code = install
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");
    expect(code).not.toMatch(/docker inspect\s+maestro-(bff|studio|postgres|worker|temporal)\b/);
    // It must ask compose which container the service resolved to.
    expect(install).toMatch(/docker compose ps -q\s+bff/);
    expect(install).toMatch(/docker compose ps -q\s+studio/);
  });
});

/**
 * The first run of a freshly copied bundle.
 *
 * `.env.example` shipped an ACTIVE `NODE_EXTRA_CA_CERTS` naming a CA file that
 * no bundle contains (`certs/` holds only `.gitkeep`). `install.sh` verifies
 * that the named file exists, so the documented flow — copy the example, fill
 * in every `DEGISTIR` — refused on the very first run, at a line the operator
 * was never told to touch. The value holds no `DEGISTIR`, so nothing marked it
 * as needing attention: it reads as a setting that is already correct.
 */
describe("banka bundle: a filled-in .env.example installs as-is", () => {
  it("ships NODE_EXTRA_CA_CERTS commented out, since no CA file is bundled", () => {
    const active = envExample
      .split("\n")
      .filter((line) => /^\s*NODE_EXTRA_CA_CERTS\s*=/.test(line));
    expect(active, "NODE_EXTRA_CA_CERTS is active but certs/ ships empty").toEqual([]);
  });

  it("still documents the setting for a site that does need it", () => {
    // Commented out is not the same as removed: a bank whose Jira runs on an
    // internally signed certificate needs this, and needs to find it here.
    expect(envExample).toContain("NODE_EXTRA_CA_CERTS");
    expect(envExample).toContain("CA_BUNDLE_DIR");
  });

  it("leaves every mandatory blank marked with the placeholder the installer greps for", () => {
    // `install.sh` refuses while any DEGISTIR remains. That contract only holds
    // if the fields needing a value actually carry the marker.
    for (const key of [
      "CONNECTOR_MASTER_KEY",
      "POSTGRES_PASSWORD",
      "REDIS_PASSWORD",
      "MAESTRO_BOT_ACCOUNT_ID",
      "MAESTRO_SECRET_KV_JIRA__TOKEN",
    ]) {
      const line = envExample.split("\n").find((candidate) => candidate.startsWith(`${key}=`));
      expect(line, `${key} is missing from .env.example`).toBeDefined();
      expect(line, `${key} ships without a DEGISTIR marker`).toContain("DEGISTIR");
    }
  });
});

/**
 * The bundle's own invariant, stated in its header: a variable that is not
 * named in a service's `environment:` block never reaches the process, however
 * carefully `.env` was filled in.
 */
describe("banka bundle: every documented variable reaches a container", () => {
  it("documents in .env.example every variable the compose interpolates", () => {
    const referenced = new Set(
      [...composeText.matchAll(/\$\{([A-Z0-9_]+)(?::[?-][^}]*)?\}/g)].map(
        (match) => match[1] as string,
      ),
    );
    const undocumented = [...referenced].filter((name) => !envExample.includes(name));
    expect(undocumented, `undocumented in .env.example: ${undocumented.join(", ")}`).toEqual([]);
  });

  it("carries no real credential", () => {
    for (const line of envExample.split("\n")) {
      const match = /^\s*(MAESTRO_SECRET_[A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (match === null) continue;
      const value = (match[2] ?? "").replace(/^["']|["']$/g, "");
      // A placeholder is fine; a filled-in secret in a shipped file is not.
      expect(
        value === "" || value.includes("DEGISTIR") || value.startsWith("yerel-endpoint"),
        `${match[1]} carries a real-looking value in .env.example`,
      ).toBe(true);
    }
    expect(envExample).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
  });
});
