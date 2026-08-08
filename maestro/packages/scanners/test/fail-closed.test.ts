import { ScanResult, isScanBlocking } from "@maestro/contracts";
import { describe, expect, it } from "vitest";
import { SCAN_ERROR_RULE_ID, createContainerScanPort, scanGateDecision } from "../src/index.js";
import { WORKSPACE, configFor, fakeClock, fixture, stubRunner } from "./helpers.js";
import type { ContainerRunOutput } from "../src/index.js";

/**
 * M27 is the reason this package exists: a security scan that did not produce a
 * trustworthy verdict must stop the flow. Every case below is a way a scan can
 * go wrong; every one of them must end as `error`, and `error` must block.
 */
function portFor(output: Partial<ContainerRunOutput> | Error, overrides = {}) {
  const stub = stubRunner(output);
  return createContainerScanPort("gitleaks", configFor("gitleaks", overrides), {
    runner: stub.runner,
    clock: fakeClock(),
  });
}

const FAILURES: [string, Partial<ContainerRunOutput> | Error][] = [
  ["the runner throws (image cannot be pulled)", new Error("no such image: manifest unknown")],
  ["the container times out", { timedOut: true, stdout: "[]" }],
  ["the tool crashes with its error exit code", { exitCode: 2, stderr: "fatal: unable to read repo" }],
  ["the tool crashes but still prints a clean report", { exitCode: 2, stdout: "[]" }],
  ["the tool exits with an unknown code", { exitCode: 137, stdout: "[]" }],
  ["stdout is empty", { exitCode: 0, stdout: "" }],
  ["stdout is not JSON", { exitCode: 0, stdout: "gitleaks: command not found" }],
  ["stdout is truncated JSON", { exitCode: 0, stdout: '[{"RuleID":"aws-acce' }],
  ["the report does not match the tool's schema", { exitCode: 0, stdout: '[{"File":"a.ts"}]' }],
  ["the runner returns something unusable", { exitCode: undefined as unknown as number }],
];

describe("fail-closed: every failure blocks (M27)", () => {
  for (const [name, output] of FAILURES) {
    it(`errors and blocks when ${name}`, async () => {
      const result = await portFor(output).run("gitleaks", WORKSPACE);

      expect(result.outcome).toBe("error");
      expect(isScanBlocking(result.outcome)).toBe(true);
      expect(ScanResult.safeParse(result).success).toBe(true);
    });
  }

  it("never throws out of run() — the caller cannot mistake a crash for a skip", async () => {
    for (const [, output] of FAILURES) {
      await expect(portFor(output).run("gitleaks", WORKSPACE)).resolves.toBeDefined();
    }
  });

  it("carries the reason as a namespaced finding, so the error is visible in evidence", async () => {
    const result = await portFor({ timedOut: true }).run("gitleaks", WORKSPACE);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.ruleId).toBe(SCAN_ERROR_RULE_ID);
    expect(result.findings[0]?.severity).toBe("critical");
    expect(result.findings[0]?.message).toMatch(/timed out/);
  });

  it("keeps tool stderr out of the result unless explicitly opted in", async () => {
    const secretish = "line: token=hunter2-not-a-real-secret";
    const quiet = await portFor({ exitCode: 2, stderr: secretish }).run("gitleaks", WORKSPACE);
    const loud = await portFor({ exitCode: 2, stderr: secretish }, { includeStderrInError: true }).run(
      "gitleaks",
      WORKSPACE,
    );

    expect(JSON.stringify(quiet)).not.toContain("hunter2");
    expect(JSON.stringify(loud)).toContain("hunter2");
  });

  it("errors when a driver is asked to run another tool", async () => {
    const result = await portFor({ stdout: "[]" }).run("trivy", WORKSPACE);

    expect(result.outcome).toBe("error");
    expect(result.findings[0]?.message).toMatch(/wired for "gitleaks"/);
  });

  it("errors on an empty workspace path instead of scanning nothing", async () => {
    const result = await portFor({ stdout: "[]" }).run("gitleaks", { workspacePath: "  " });

    expect(result.outcome).toBe("error");
  });

  it("errors on a diff base that could be read as a flag", async () => {
    const result = await portFor({ stdout: "[]" }).run("gitleaks", {
      ...WORKSPACE,
      diffBaseRef: "--exec=rm -rf /",
    });

    expect(result.outcome).toBe("error");
    expect(result.findings[0]?.message).toMatch(/diffBaseRef/);
  });

  it("blocks on an error no matter how permissive the threshold is", async () => {
    const result = await portFor({ timedOut: true }, { blockLevel: "critical" }).run("gitleaks", WORKSPACE);

    expect(result.outcome).toBe("error");
    expect(isScanBlocking(result.outcome)).toBe(true);
  });

  it("cannot be talked into a pass by a tool that reported an internal error", async () => {
    const stub = stubRunner({ exitCode: 1, stdout: fixture("semgrep-fatal") });
    const semgrep = createContainerScanPort("semgrep", configFor("semgrep"), {
      runner: stub.runner,
      clock: fakeClock(),
    });

    const result = await semgrep.run("semgrep", WORKSPACE);

    expect(result.outcome).toBe("error");
    expect(result.findings[0]?.message).toMatch(/semgrep reported/);
  });
});

describe('"the scan never ran" cannot open the gate', () => {
  it("blocks when a mandatory tool produced no result at all", async () => {
    const passed = await portFor({ stdout: "[]" }).run("gitleaks", WORKSPACE);

    const decision = scanGateDecision([passed]);

    expect(decision.blocking).toBe(true);
    expect(decision.missing).toEqual(["semgrep", "trivy"]);
  });

  it("blocks on an empty result set — no scans at all is not a pass", () => {
    expect(scanGateDecision([]).blocking).toBe(true);
  });
});
