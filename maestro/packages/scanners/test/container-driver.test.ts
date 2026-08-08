import { ScanResult } from "@maestro/contracts";
import { describe, expect, it } from "vitest";
import { ScanConfigError, createContainerScanPort } from "../src/index.js";
import { IMAGES, WORKSPACE, configFor, fakeClock, fixture, stubRunner } from "./helpers.js";

function driver(tool: "gitleaks" | "semgrep" | "trivy", output: Record<string, unknown>, overrides = {}) {
  const stub = stubRunner(output);
  const port = createContainerScanPort(tool, configFor(tool, overrides), {
    runner: stub.runner,
    clock: fakeClock(),
  });
  return { port, stub };
}

describe("container invocation", () => {
  it("runs the pinned image read-only, offline, with the configured timeout", async () => {
    const { port, stub } = driver("trivy", { stdout: fixture("trivy-clean") }, { timeoutSeconds: 300 });

    await port.run("trivy", WORKSPACE);

    expect(stub.requests[0]).toMatchObject({
      image: IMAGES.trivy,
      workspacePath: WORKSPACE.workspacePath,
      workspaceMountPath: "/workspace",
      network: "none",
      timeoutSeconds: 300,
    });
  });

  it("asks gitleaks for a JSON report of the working tree", async () => {
    const { port, stub } = driver("gitleaks", { stdout: "[]" });

    await port.run("gitleaks", WORKSPACE);

    expect(stub.requests[0]?.argv).toEqual([
      "gitleaks", "detect", "--source", "/workspace", "--no-git",
      "--report-format", "json", "--report-path", "/dev/stdout",
    ]);
  });

  it("scopes gitleaks to a commit range when a diff base is given", async () => {
    const { port, stub } = driver("gitleaks", { stdout: "[]" });

    await port.run("gitleaks", { ...WORKSPACE, diffBaseRef: "origin/main" });

    expect(stub.requests[0]?.argv).toContain("--log-opts");
    expect(stub.requests[0]?.argv).toContain("origin/main..HEAD");
    expect(stub.requests[0]?.argv).not.toContain("--no-git");
  });

  it("passes semgrep a locally pinned ruleset and no metrics", async () => {
    const { port, stub } = driver("semgrep", { stdout: '{"results":[],"errors":[]}' });

    await port.run("semgrep", { ...WORKSPACE, diffBaseRef: "release/2026.08" });

    expect(stub.requests[0]?.argv).toEqual([
      "semgrep", "scan", "--json", "--quiet", "--metrics=off",
      "--config", "/rules/bank-ruleset.yaml",
      "--baseline-commit", "release/2026.08", "/workspace",
    ]);
  });

  it("asks trivy for vulnerabilities of the mounted filesystem", async () => {
    const { port, stub } = driver("trivy", { stdout: fixture("trivy-clean") });

    await port.run("trivy", WORKSPACE);

    expect(stub.requests[0]?.argv).toEqual([
      "trivy", "fs", "--format", "json", "--quiet", "--scanners", "vuln", "/workspace",
    ]);
  });

  it("appends configured extra arguments", async () => {
    const { port, stub } = driver("trivy", { stdout: fixture("trivy-clean") }, { extraArgs: ["--skip-dirs", "vendor"] });

    await port.run("trivy", WORKSPACE);

    expect(stub.requests[0]?.argv.join(" ")).toContain("--skip-dirs vendor");
  });
});

describe("outcome of a scan that ran", () => {
  it("passes a clean scan and stamps the image digest and clock", async () => {
    const { port } = driver("gitleaks", { stdout: "[]" });

    const result = await port.run("gitleaks", WORKSPACE);

    expect(result.outcome).toBe("pass");
    expect(result.findings).toEqual([]);
    expect(result.imageDigest).toBe(`sha256:${"1".repeat(64)}`);
    expect(result.startedAt).toBe("2026-08-08T10:00:00.000Z");
    expect(result.finishedAt).toBe("2026-08-08T10:00:01.000Z");
    expect(ScanResult.safeParse(result).success).toBe(true);
  });

  it("fails when a finding reaches the block level", async () => {
    // gitleaks exits 1 when it finds leaks — a completed run, not an error.
    const { port } = driver("gitleaks", { exitCode: 1, stdout: fixture("gitleaks-report") });

    const result = await port.run("gitleaks", WORKSPACE);

    expect(result.outcome).toBe("fail");
    expect(result.findings).toHaveLength(2);
  });

  it("reports findings below the threshold without failing", async () => {
    const { port } = driver("trivy", { stdout: fixture("trivy-fs") }, { blockLevel: "critical" });

    const result = await port.run("trivy", WORKSPACE);

    expect(result.outcome).toBe("pass");
    expect(result.findings).toHaveLength(2);
  });

  it("fails the same scan once the threshold is lowered", async () => {
    const { port } = driver("trivy", { stdout: fixture("trivy-fs") }, { blockLevel: "medium" });

    expect((await port.run("trivy", WORKSPACE)).outcome).toBe("fail");
  });
});

describe("configuration is refused at wiring time, not at scan time", () => {
  const runner = stubRunner().runner;

  it("refuses an image that is not digest-pinned", () => {
    expect(() => createContainerScanPort("trivy", { image: "aquasec/trivy:latest" }, { runner })).toThrow(
      ScanConfigError,
    );
  });

  it("refuses semgrep without a locally pinned ruleset", () => {
    expect(() => createContainerScanPort("semgrep", { image: IMAGES.semgrep }, { runner })).toThrow(/rulesRef/);
  });

  it("refuses a driver with no container runner", () => {
    expect(() => createContainerScanPort("trivy", configFor("trivy"), {})).toThrow(/deps.runner/);
  });
});
