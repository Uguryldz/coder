import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bankaVariantAuditPath, ugurdockerVariantAuditPath } from "./paths.js";

/**
 * The operator's agent-model audit script, checked as data in BOTH bundles.
 *
 * The story it closes: `seedDefaultVariants` never touches an existing variant
 * (M38/M83), so a bank that installed an older release keeps the cloud model
 * that release seeded — `anthropic/claude-sonnet-4.5`, unreachable on an
 * air-gapped network — and the new image does not fix it. This script is the
 * supported way out, so the same assertions that protect `reset-admin.sh`
 * protect it: it must exist in both bundles, stay byte-identical, run the
 * tested bin inside the application image, and default to REPORTING.
 */

const ugurdocker = readFileSync(ugurdockerVariantAuditPath(), "utf8");
const banka = readFileSync(bankaVariantAuditPath(), "utf8");

describe("ajan-modelleri.sh: one script, two bundles", () => {
  it("ships in both bundles", () => {
    expect(existsSync(ugurdockerVariantAuditPath())).toBe(true);
    expect(existsSync(bankaVariantAuditPath())).toBe(true);
  });

  it("is byte-identical between the bundles — the twins may not drift", () => {
    expect(ugurdocker).toBe(banka);
  });

  it("is executable, the way the ./ajan-modelleri.sh invocation needs", () => {
    for (const path of [ugurdockerVariantAuditPath(), bankaVariantAuditPath()]) {
      expect(() => accessSync(path, constants.X_OK), `${path} is not executable`).not.toThrow();
    }
  });
});

describe("ajan-modelleri.sh: how it does the job", () => {
  it("runs the compiled bin inside the application image, not a host toolchain", () => {
    // Same bet install.sh makes: the image ships `dist/` only, and neither node
    // nor pnpm is installed on a bank's server.
    expect(banka).toContain("MAESTRO_ENTRYPOINT=apps/deploy/dist/bin/audit-variant-models.js");
    expect(banka).not.toMatch(/\btsx\b/);
  });

  it("names a bin that actually exists in this repo", () => {
    // The literal above is a path no compiler reads; without this it goes stale
    // silently and every operator invocation dies with ERR_MODULE_NOT_FOUND.
    const source = fileURLToPath(new URL("../src/bin/audit-variant-models.ts", import.meta.url));
    expect(existsSync(source), `${source} does not exist`).toBe(true);
  });

  it("defaults to reporting and writes only behind an explicit flag", () => {
    // The safety property that makes this script runnable on a live bank: with
    // no argument it must not be able to reach the repairing invocation.
    expect(banka).toContain("--duzelt");
    expect(banka).toMatch(/DUZELT=0/);
  });

  it("refuses an unknown argument instead of silently reporting", () => {
    // `./ajan-modelleri.sh --fixx` must not look like a clean audit.
    expect(banka).toContain("Bilinmeyen argüman");
  });

  it("points the operator at the panel as the better, per-agent fix", () => {
    expect(banka).toContain("Ajan tanımları");
  });
});
