import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bankaSweepCheckPath, ugurdockerSweepCheckPath } from "./paths.js";

/**
 * The "no tickets are arriving" triage script, checked as data in BOTH bundles.
 *
 * Why it needs the same protection as `tani.sh` and `ajan-modelleri.sh`: on a
 * Data Center install there is no webhook to register, so the JQL sweep is the
 * ONLY door a ticket can walk through. When that door is shut the whole stack
 * still looks healthy — panel green, connection green, listening rules right,
 * and not one ticket ever enters. This script is what turns that silence into
 * a named cause, which makes shipping it in only one bundle the same class of
 * defect it exists to diagnose: the operator who needs it most (the bank, air
 * gapped, webhook-less) would be the one who never received it.
 *
 * It ships as a HOST-side script rather than a bin inside the image on purpose:
 * two of the six conditions it measures — is the BFF container up at all, and
 * does the boot log name a sweep — cannot be observed from inside the very
 * container whose absence is the thing being tested.
 */

const ugurdocker = readFileSync(ugurdockerSweepCheckPath(), "utf8");
const banka = readFileSync(bankaSweepCheckPath(), "utf8");

describe("tarama-kontrol.sh: one script, two bundles", () => {
  it("ships in both bundles", () => {
    expect(existsSync(ugurdockerSweepCheckPath())).toBe(true);
    expect(existsSync(bankaSweepCheckPath())).toBe(true);
  });

  it("is byte-identical between the bundles — the twins may not drift", () => {
    expect(ugurdocker).toBe(banka);
  });

  it("is executable in both bundles", () => {
    // A script the operator has to `chmod +x` first is a script that reads as
    // broken on the one day it is reached for.
    expect(() => accessSync(ugurdockerSweepCheckPath(), constants.X_OK)).not.toThrow();
    expect(() => accessSync(bankaSweepCheckPath(), constants.X_OK)).not.toThrow();
  });

  it("runs from its own directory, so `.env` is found wherever it is invoked", () => {
    // `cd "$(dirname "$0")"` — the operator runs this from a shell that may sit
    // anywhere; the compose project and `.env` live beside the script.
    expect(banka).toMatch(/cd "\$\(dirname "\$0"\)"/);
  });

  it("reads only — it never writes to Jira, the database or the compose stack", () => {
    // A triage tool that repairs is a triage tool nobody dares run while the
    // symptom is live. Reading `psql -tAc` and `docker compose logs` is the
    // whole contract.
    expect(banka).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER)\b/i);
    // Only lines that RUN a command count. `docker compose up -d` also appears
    // inside an `echo` that tells the operator what to do next, and quoting a
    // remedy is not performing one — a check that cannot tell those apart would
    // force the advice to be dropped to stay green.
    const executed = banka
      .split("\n")
      .filter((line) => !/^\s*(#|echo\b|printf\b)/.test(line))
      .join("\n");
    expect(executed).not.toMatch(/docker compose (up|down|restart|stop|rm)\b/);
  });

  it("keeps `set -u` but NOT `set -e` — a failed probe must not abort the triage", () => {
    // Every check after an early exit is a check the operator does not get, and
    // the probe most likely to fail is exactly the one whose failure is the
    // answer. `pipefail` stays so a broken pipe is not read as success.
    expect(banka).toMatch(/set -uo pipefail/);
    expect(banka).not.toMatch(/set -euo/);
  });
});
