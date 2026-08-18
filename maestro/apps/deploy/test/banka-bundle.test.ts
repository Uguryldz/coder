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
    //
    // The list is SHORT now, and that is the point of it. What is left is
    // infrastructure — the two datastore passwords and the key that enciphers
    // everything else — plus the one inbound secret that cannot come from the
    // store it would have to authenticate a request against (see below).
    for (const key of [
      "CONNECTOR_MASTER_KEY",
      "POSTGRES_PASSWORD",
      "REDIS_PASSWORD",
      "MAESTRO_SECRET_KV_JIRA__WEBHOOK",
    ]) {
      const line = envExample.split("\n").find((candidate) => candidate.startsWith(`${key}=`));
      expect(line, `${key} is missing from .env.example`).toBeDefined();
      expect(line, `${key} ships without a DEGISTIR marker`).toContain("DEGISTIR");
    }
  });

  it("no longer demands the credentials the connector panel now owns", () => {
    /**
     * THE SHRINK, as a property rather than an edit.
     *
     * These were fills an operator had to perform in a file on the server,
     * for credentials the panel ALREADY collects, tests live and enciphers.
     * Worse, the two never met: the panel's Jira token was stored, tested and
     * shown green while every run authenticated with the `.env` one.
     *
     * A run now reads the managed connection first
     * (`stores/connection-secrets.ts`), so demanding these here would be
     * demanding the same secret twice in two places that could disagree.
     * Whatever remains of them in the bundle must therefore be OPTIONAL —
     * either commented out or shipped empty — never a DEGISTIR the installer
     * refuses to start without.
     */
    for (const key of ["MAESTRO_SECRET_KV_JIRA__TOKEN", "MAESTRO_BOT_ACCOUNT_ID"]) {
      const line = envExample.split("\n").find((candidate) => candidate.startsWith(`${key}=`));
      expect(line ?? "", `${key} is still a mandatory fill`).not.toContain("DEGISTIR");
    }

    // And the installer must not refuse a stack that leaves them to the panel.
    // `ZORUNLU` is the list it dies over; a name in it is a name that has to be
    // in the file whatever the panel holds.
    const mandatory = install.slice(install.indexOf("ZORUNLU=("));
    const list = mandatory.slice(0, mandatory.indexOf(")"));
    expect(list).not.toContain("MAESTRO_SECRET_KV_JIRA__TOKEN");
    expect(list).not.toContain("MAESTRO_BOT_ACCOUNT_ID");
  });

  it("keeps the webhook secret in the file, with its reason written down", () => {
    /**
     * The one credential that did NOT move, and must not.
     *
     * Every other reference is resolved on an OUTBOUND call the platform chose
     * to make. This one is resolved on an INBOUND, UNAUTHENTICATED request:
     * `POST /webhooks/jira` verifies the signature before it parses the body
     * and before anything has established the caller is Jira. Serving it from
     * the connection store would put a database read in front of the signature
     * check on an unrate-limited route — every forged delivery would become a
     * query.
     *
     * The reasoning is asserted, not just the value: an operator who finds one
     * lone `MAESTRO_SECRET_*` line among credentials that all moved to the
     * panel will reasonably assume it was overlooked, and delete it.
     */
    const line = envExample
      .split("\n")
      .find((candidate) => candidate.startsWith("MAESTRO_SECRET_KV_JIRA__WEBHOOK="));
    expect(line).toBeDefined();
    expect(envExample).toContain("BU NEDEN PANELE TAŞINMADI");
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
