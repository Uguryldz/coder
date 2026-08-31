import { accessSync, constants, existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BEKLENEN_MIGRATION } from "../src/bin/tani.js";
import { bankaInstallPath, bankaTaniPath, migrationsDir, ugurdockerTaniPath } from "./paths.js";

/**
 * The operator's diagnostic script, checked as data in BOTH bundles.
 *
 * The story it closes: when something broke, the evidence that reached us was
 * `docker compose logs` pasted in pieces — and twice the answer was buried
 * under thousands of postgres checkpoint lines, temporal lifecycle lines and
 * nginx 2xx access lines. This script replaces that with one page.
 *
 * The assertions that protect `reset-admin.sh` and `ajan-modelleri.sh` protect
 * it, plus the properties unique to a tool that RUNS ON A LIVE BANK and whose
 * output is DELIBERATELY SENT OUTSIDE the institution.
 */

const ugurdocker = readFileSync(ugurdockerTaniPath(), "utf8");
const banka = readFileSync(bankaTaniPath(), "utf8");

describe("tani.sh: one script, two bundles", () => {
  it("ships in both bundles", () => {
    expect(existsSync(ugurdockerTaniPath())).toBe(true);
    expect(existsSync(bankaTaniPath())).toBe(true);
  });

  it("is byte-identical between the bundles — the twins may not drift", () => {
    // Like the reset and audit scripts, the diagnostic flow has no
    // bundle-specific step at all, so the strongest possible lock holds.
    expect(ugurdocker).toBe(banka);
  });

  it("is executable, the way the ./tani.sh invocation needs", () => {
    for (const path of [ugurdockerTaniPath(), bankaTaniPath()]) {
      expect(() => accessSync(path, constants.X_OK), `${path} is not executable`).not.toThrow();
    }
  });
});

describe("tani.sh: how it does the job", () => {
  it("runs the compiled bin inside the application image, not a host toolchain", () => {
    // Same bet install.sh makes: the image ships `dist/` only, and neither node
    // nor pnpm is installed on a bank's server.
    expect(banka).toContain("MAESTRO_ENTRYPOINT=apps/deploy/dist/bin/tani.js");
    expect(banka).not.toMatch(/\btsx\b/);
  });

  it("names a bin that actually exists in this repo", () => {
    // The literal above is a path no compiler reads; without this it goes stale
    // silently and every operator invocation dies with ERR_MODULE_NOT_FOUND.
    const source = fileURLToPath(new URL("../src/bin/tani.ts", import.meta.url));
    expect(existsSync(source), `${source} does not exist`).toBe(true);
  });

  it("pipes the host-collected logs in WITHOUT allocating a tty", () => {
    // `docker compose run` allocates a TTY by default, and a TTY-attached stdin
    // is the terminal — the bin would then wait forever on an input that never
    // arrives. `-T` is the whole reason this two-halves design works.
    expect(banka).toContain("docker compose run --rm -T");
    expect(banka).toMatch(/<"\$\{TMP\}\/girdi\.json"/);
  });

  it("refuses an unknown argument instead of silently producing a partial report", () => {
    // `./tani.sh --satirr 500` must not look like a complete 500-line report.
    expect(banka).toContain("Bilinmeyen argüman");
  });

  it("offers exactly the four documented switches", () => {
    for (const flag of ["--satir", "--jira-yok", "--ticket", "--cikti"]) {
      expect(banka, flag).toContain(flag);
    }
  });

  it("validates --satir rather than passing a word through as a line count", () => {
    expect(banka).toMatch(/\[\[ "\$2" =~ \^\[0-9\]\+\$ \]\]/);
  });

  it("refuses to write an EMPTY report file", () => {
    // A zero-byte HTML opens as a blank page in a browser, and a blank page
    // reads as "the tool ran". It must read as "the tool failed" instead.
    expect(banka).toContain('[[ ! -s "${TMP}/rapor.html" ]]');
  });

  it("collects every service in the compose file, tolerating an absent one", () => {
    for (const service of ["bff", "worker", "migrate", "studio", "postgres", "redis", "temporal"]) {
      expect(banka, service).toContain(service);
    }
    // A service that does not exist in one bundle (autoheal) or has never
    // started must not kill the report.
    expect(banka).toMatch(/docker compose logs .*\|\| true/);
  });

  it("builds its JSON with a real serializer, not hand-rolled quoting", () => {
    // A log line can contain any character — quote, backslash, control byte.
    // Escaping those by hand produces a JSON that breaks on precisely the line
    // being diagnosed.
    expect(banka).toContain("python3");
    expect(banka).toContain("json.dump");
    expect(banka).toContain("python3 bulunamadı");
  });

  it("checks its preconditions the way the sibling scripts do", () => {
    expect(banka).toContain("docker compose version");
    expect(banka).toContain(".env yok");
    expect(banka).toContain("docker compose ps -q postgres");
  });
});

describe("tani.sh: safe to run on a live bank", () => {
  it("passes no repair or write flag to the bin", () => {
    // The audit it calls has a `--duzelt` mode. A diagnostic tool must never
    // reach it: reporting is the whole contract.
    expect(banka).not.toContain("--duzelt");
    expect(banka).not.toContain("--fix");
  });

  it("promises no side effects in the operator's own words", () => {
    expect(banka).toContain("YAN ETKİ YOK");
  });

  it("tells the operator the output is meant to be SENT, and to look first", () => {
    // Masking is best-effort, and saying so is the honest half of shipping it.
    expect(banka).toContain("SIR POLİTİKASI");
    expect(banka).toMatch(/en iyi çabadır/);
  });

  it("never echoes a secret VALUE out of .env — only the image name", () => {
    // The one .env value read on the host is the image tag, which is a
    // deployment fact rather than a credential.
    const envOkumalari = banka.match(/grep -oE '\^[A-Z_]+=/g) ?? [];
    expect(envOkumalari).toEqual(["grep -oE '^MAESTRO_NODE_IMAGE="]);
  });
});

describe("tani.sh: the migration count cannot go stale", () => {
  it("expects the same minimum install.sh does", () => {
    // Two hand-written literals in two languages, neither read by a compiler.
    // This is the same guard the installers' `MIG_BEKLENEN` already carries —
    // it went stale once before, and a diagnostic that reports a stale schema
    // as healthy is worse than no diagnostic.
    const install = readFileSync(bankaInstallPath(), "utf8");
    const eslesme = /MIG_BEKLENEN=(\d+)/.exec(install);
    expect(eslesme, "install.sh no longer declares MIG_BEKLENEN").not.toBeNull();
    expect(BEKLENEN_MIGRATION).toBe(Number(eslesme?.[1]));
  });

  it("is not ahead of the migrations this repo actually ships", () => {
    const klasorler = readdirSync(migrationsDir(), { withFileTypes: true }).filter((entry) =>
      entry.isDirectory(),
    );
    expect(BEKLENEN_MIGRATION).toBeLessThanOrEqual(klasorler.length);
  });
});
