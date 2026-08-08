import { ScanFinding } from "@maestro/contracts";
import { describe, expect, it } from "vitest";
import { ScanParseError, parseGitleaks, parseSemgrep, parseTrivy } from "../src/index.js";
import { fixture } from "./helpers.js";

const CONTEXT = { secretSeverity: "critical" as const };

describe("gitleaks report parsing", () => {
  const parsed = parseGitleaks(fixture("gitleaks-report"), CONTEXT);

  it("maps every finding of the recorded report shape", () => {
    expect(parsed.findings).toHaveLength(2);
    expect(parsed.findings[0]).toEqual({
      tool: "gitleaks",
      severity: "critical",
      ruleId: "aws-access-token",
      file: "src/config/aws.ts",
      line: 12,
      message: expect.stringContaining("AWS credentials"),
    });
  });

  it("grades secrets from configuration, since gitleaks reports no severity", () => {
    const low = parseGitleaks(fixture("gitleaks-report"), { secretSeverity: "low" });

    expect(low.findings.map((f) => f.severity)).toEqual(["low", "low"]);
  });

  it("never copies the matched secret into a finding (M20/M34)", () => {
    const serialized = JSON.stringify(parsed.findings);

    expect(serialized).not.toContain("AKIA");
    expect(serialized).not.toContain("Secret");
  });

  it("treats [] and null (an empty Go slice) as a clean report", () => {
    expect(parseGitleaks("[]", CONTEXT).findings).toEqual([]);
    expect(parseGitleaks("null", CONTEXT).findings).toEqual([]);
  });

  it("refuses a report whose entries lack the fields it maps", () => {
    expect(() => parseGitleaks('[{"File":"a.ts"}]', CONTEXT)).toThrow(ScanParseError);
  });

  it("produces contract-valid findings", () => {
    for (const finding of parsed.findings) expect(ScanFinding.safeParse(finding).success).toBe(true);
  });
});

describe("semgrep report parsing", () => {
  const parsed = parseSemgrep(fixture("semgrep-results"));

  it("prefers the rule author's metadata severity over the result level", () => {
    // extra.severity is WARNING, extra.metadata.severity is HIGH.
    expect(parsed.findings[0]?.severity).toBe("high");
  });

  it("falls back to the semgrep level when the rule has no graded metadata", () => {
    expect(parsed.findings[1]?.severity).toBe("low");
  });

  it("drops results semgrep itself marked as ignored", () => {
    expect(parsed.findings).toHaveLength(2);
    expect(parsed.findings.map((f) => f.ruleId)).not.toContain(
      "typescript.lang.security.audit.suppressed-example",
    );
  });

  it("maps path and start line", () => {
    expect(parsed.findings[0]?.file).toBe("src/routes/login.ts");
    expect(parsed.findings[0]?.line).toBe(42);
  });

  it("treats an unknown severity label as serious, not as noise", () => {
    const report = JSON.stringify({
      results: [{ check_id: "r", path: "a.ts", start: { line: 1 }, extra: { message: "m", severity: "BRAND_NEW" } }],
    });

    expect(parseSemgrep(report).findings[0]?.severity).toBe("high");
  });

  it("reports a fatal when semgrep logged an error, even with zero findings", () => {
    const fatal = parseSemgrep(fixture("semgrep-fatal"));

    expect(fatal.findings).toEqual([]);
    expect(fatal.fatal).toMatch(/SourceParseError|Syntax error|error/);
  });

  it("does not turn a warn-level entry into a fatal", () => {
    const report = JSON.stringify({ results: [], errors: [{ level: "warn", message: "partially scanned" }] });

    expect(parseSemgrep(report).fatal).toBeUndefined();
  });

  it("refuses output without a results array", () => {
    expect(() => parseSemgrep('{"errors":[]}')).toThrow(ScanParseError);
  });
});

describe("trivy report parsing", () => {
  const parsed = parseTrivy(fixture("trivy-fs"));

  it("flattens Results[].Vulnerabilities[] into findings", () => {
    expect(parsed.findings).toHaveLength(2);
    expect(parsed.findings[0]).toMatchObject({
      tool: "trivy",
      severity: "high",
      ruleId: "CVE-2020-8203",
      file: "package-lock.json",
    });
    expect(parsed.findings[0]?.message).toContain("lodash 4.17.15");
    expect(parsed.findings[0]?.message).toContain("fixed in 4.17.19");
  });

  it("does not park an UNKNOWN severity below every threshold", () => {
    expect(parsed.findings[1]?.severity).toBe("medium");
  });

  it("accepts a target with no Vulnerabilities key", () => {
    expect(parsed.findings.filter((f) => f.file === "go.sum")).toEqual([]);
  });

  it("accepts a clean report that omits Results entirely", () => {
    expect(parseTrivy(fixture("trivy-clean")).findings).toEqual([]);
  });

  it("refuses a vulnerability without an id", () => {
    const report = JSON.stringify({ Results: [{ Target: "a", Vulnerabilities: [{ Severity: "HIGH" }] }] });

    expect(() => parseTrivy(report)).toThrow(ScanParseError);
  });
});

describe("unreadable output is never an empty finding list", () => {
  const parsers = [
    ["gitleaks", (text: string) => parseGitleaks(text, CONTEXT)],
    ["semgrep", (text: string) => parseSemgrep(text)],
    ["trivy", (text: string) => parseTrivy(text)],
  ] as const;

  for (const [name, parse] of parsers) {
    it(`${name}: empty stdout and non-JSON both throw`, () => {
      expect(() => parse("")).toThrow(ScanParseError);
      expect(() => parse("   ")).toThrow(ScanParseError);
      expect(() => parse("panic: runtime error")).toThrow(ScanParseError);
      expect(() => parse('{"truncated": ')).toThrow(ScanParseError);
    });
  }
});
