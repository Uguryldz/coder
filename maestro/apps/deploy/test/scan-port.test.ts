import type { ScanPort } from "@maestro/ports";
import { describe, expect, it } from "vitest";
import { loadDeployEnv } from "../src/env.js";
import { scanDriverFor } from "../src/driver-config.js";
import { NOT_CONFIGURED_DRIVER } from "../src/profile.js";
import { CONTAINER_TRIO_DRIVER, compositeScanPort, trioSelectionFrom } from "../src/stores/scan-port.js";
import { scanRunnerOption } from "../src/bin/worker.js";

const MINIMAL: Record<string, string> = {
  NODE_ENV: "development",
  DATABASE_URL: "postgresql://maestro:x@localhost:5432/maestro",
  JIRA_BASE_URL: "https://jira.example.local",
  ADO_BASE_URL: "https://dev.azure.com",
  LLM_BASE_URL: "https://llm.example.local/v1",
  STORAGE_ENDPOINT: "https://s3.example.local",
  VAULT_ADDR: "https://vault.example.local",
};
const DIGEST = "@sha256:" + "b".repeat(64);
const IMAGES = {
  SCAN_IMAGE_GITLEAKS: `zricethezav/gitleaks${DIGEST}`,
  SCAN_IMAGE_SEMGREP: `semgrep/semgrep${DIGEST}`,
  SCAN_IMAGE_TRIVY: `aquasec/trivy${DIGEST}`,
  SCAN_SEMGREP_RULES: "/rules/semgrep.yml",
};

describe("scan driver selection (M27, three images or nothing)", () => {
  it("stays not-configured with no images and says nothing", () => {
    expect(scanDriverFor(loadDeployEnv(MINIMAL), NOT_CONFIGURED_DRIVER)).toEqual({ driver: NOT_CONFIGURED_DRIVER, note: null });
  });

  it("two of three is still not-configured, and the note names the missing variable", () => {
    const env = loadDeployEnv({ ...MINIMAL, SCAN_IMAGE_GITLEAKS: IMAGES.SCAN_IMAGE_GITLEAKS, SCAN_IMAGE_TRIVY: IMAGES.SCAN_IMAGE_TRIVY });
    const chosen = scanDriverFor(env, NOT_CONFIGURED_DRIVER);
    expect(chosen.driver).toBe(NOT_CONFIGURED_DRIVER);
    expect(chosen.note).toContain("SCAN_IMAGE_SEMGREP");
    expect(chosen.note).not.toContain("SCAN_IMAGE_GITLEAKS");
  });

  it("three images without semgrep rules is still not-configured — rules are never fetched at scan time", () => {
    const { SCAN_SEMGREP_RULES: _rules, ...imagesOnly } = IMAGES;
    const chosen = scanDriverFor(loadDeployEnv({ ...MINIMAL, ...imagesOnly }), NOT_CONFIGURED_DRIVER);
    expect(chosen.driver).toBe(NOT_CONFIGURED_DRIVER);
    expect(chosen.note).toContain("SCAN_SEMGREP_RULES");
  });

  it("three images plus the rules upgrade the profile's not-configured to the container trio", () => {
    expect(scanDriverFor(loadDeployEnv({ ...MINIMAL, ...IMAGES }), NOT_CONFIGURED_DRIVER).driver).toBe(CONTAINER_TRIO_DRIVER);
  });

  it("never overrides a profile that already chose a scan driver", () => {
    expect(scanDriverFor(loadDeployEnv({ ...MINIMAL, ...IMAGES }), "sonarqube").driver).toBe("sonarqube");
  });

  it("trioSelectionFrom treats blanks as missing and names variables", () => {
    expect(trioSelectionFrom({ images: { gitleaks: " ", semgrep: "x", trivy: undefined }, semgrepRules: "" }).missing).toEqual([
      "SCAN_IMAGE_GITLEAKS",
      "SCAN_IMAGE_TRIVY",
      "SCAN_SEMGREP_RULES",
    ]);
  });
});

describe("compositeScanPort", () => {
  it("fans out by tool and refuses a tool it was not composed for, naming the variable", async () => {
    const calls: string[] = [];
    const port = (name: string): ScanPort => ({
      run: (tool) => {
        calls.push(`${name}:${tool}`);
        return Promise.resolve({ tool, imageDigest: "sha256:x", startedAt: "a", finishedAt: "b", findings: [], outcome: "pass" } as never);
      },
    });
    const composite = compositeScanPort({ gitleaks: port("g"), trivy: port("t") });
    await composite.run("gitleaks", { workspacePath: "/w" });
    await composite.run("trivy", { workspacePath: "/w" });
    expect(calls).toEqual(["g:gitleaks", "t:trivy"]);
    await expect(composite.run("semgrep", { workspacePath: "/w" })).rejects.toThrow(/SCAN_IMAGE_SEMGREP/);
  });
});

describe("scanRunnerOption", () => {
  it("wires nothing without a daemon-side mapping; a blank WORKSPACE_ROOT means the default /workspace", () => {
    expect(scanRunnerOption({})).toEqual({});
    expect(scanRunnerOption({ WORKSPACE_ROOT: "/workspace" })).toEqual({});
    // The clone lives under the default root when the variable is blank — so does the scan.
    expect(scanRunnerOption({ WORKSPACE_VOLUME: "v" }).containerRunner).toBeDefined();
    expect(scanRunnerOption({ WORKSPACE_ROOT: "", WORKSPACE_VOLUME: "v" }).containerRunner).toBeDefined();
  });

  it("wires a runner for a named volume, and prefers a host root when both are set", () => {
    expect(scanRunnerOption({ WORKSPACE_ROOT: "/workspace", WORKSPACE_VOLUME: "maestro_maestro-workspace" }).containerRunner).toBeDefined();
    expect(scanRunnerOption({ WORKSPACE_ROOT: "/workspace", RUNNER_WORKSPACE_HOST_ROOT: "/srv/ws", WORKSPACE_VOLUME: "v" }).containerRunner).toBeDefined();
  });
});
