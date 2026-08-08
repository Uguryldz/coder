import type { ScanFinding, ScanSeverity } from "@maestro/contracts";
import { z } from "zod";
import { messageOr, optionalText, parseJson, parseWith, type ParsedScan } from "./common.js";

/**
 * trivy `--format json`: `{ SchemaVersion, ArtifactName, Results[] }`, each
 * result `{ Target, Class, Type, Vulnerabilities[] }`. `Results` is absent when
 * there was nothing to scan and `Vulnerabilities` is absent (not `[]`) when
 * clean. Only `Vulnerabilities` is mapped — `Secrets` (gitleaks' job here) and
 * `Misconfigurations` are out of scope, see RAPOR.md.
 */
const TrivyVulnerability = z.looseObject({
  VulnerabilityID: z.string().min(1),
  PkgName: z.string().optional(),
  InstalledVersion: z.string().optional(),
  FixedVersion: z.string().optional(),
  Title: z.string().optional(),
  Severity: z.string().optional(),
});

const TrivyResult = z.looseObject({
  Target: z.string().optional(),
  Vulnerabilities: z.array(TrivyVulnerability).nullish(),
});

const TrivyReport = z.looseObject({
  SchemaVersion: z.number().int().optional(),
  Results: z.array(TrivyResult).nullish(),
});

const TRIVY_SEVERITY: Record<string, ScanSeverity> =
  { CRITICAL: "critical", HIGH: "high", MEDIUM: "medium", LOW: "low" };

/**
 * `UNKNOWN` means no source rated the CVE, not that it is harmless: mapping it
 * to `info` would park every unrated vulnerability below any threshold.
 */
const UNRATED_SEVERITY: ScanSeverity = "medium";

export function trivySeverity(value: string | undefined): ScanSeverity {
  return TRIVY_SEVERITY[value?.toUpperCase() ?? ""] ?? UNRATED_SEVERITY;
}

export function parseTrivy(stdout: string): ParsedScan {
  const report = parseWith("trivy", TrivyReport, parseJson("trivy", stdout));

  const findings: ScanFinding[] = [];
  for (const result of report.Results ?? []) {
    for (const vulnerability of result.Vulnerabilities ?? []) {
      findings.push({
        tool: "trivy",
        severity: trivySeverity(vulnerability.Severity),
        ruleId: vulnerability.VulnerabilityID,
        file: optionalText(result.Target),
        message: describe(vulnerability),
      });
    }
  }
  return { findings };
}

function describe(vulnerability: z.infer<typeof TrivyVulnerability>): string {
  const pkg = [vulnerability.PkgName, vulnerability.InstalledVersion].filter(Boolean).join(" ");
  const fix = vulnerability.FixedVersion ? ` (fixed in ${vulnerability.FixedVersion})` : "";
  const title = messageOr(vulnerability.VulnerabilityID, vulnerability.Title);
  return pkg ? `${pkg}: ${title}${fix}` : `${title}${fix}`;
}
