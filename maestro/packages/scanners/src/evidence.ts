import { createHash } from "node:crypto";
import { EvidenceFile, isScanBlocking, type ScanResult, type ScanTool } from "@maestro/contracts";
import { CORE_SCAN_TOOLS } from "./config.js";
import { SCAN_ERROR_RULE_ID } from "./result.js";
import { countBySeverity, SEVERITY_ORDER } from "./severity.js";

/** Folder the scan evidence lands in inside the package (M34). */
export const SCAN_EVIDENCE_DIR = "scan";

export interface EvidenceArtifact {
  /** Path inside the evidence package. */ name: string;
  contentType: string;
  body: string;
}

export interface ScanGateDecision {
  blocking: boolean;
  /** Required tools with no result at all — the "we never ran it" case. */
  missing: ScanTool[];
  blockingTools: ScanTool[];
  reasons: string[];
}

/**
 * Whole-gate verdict (M27). A MISSING result blocks exactly like a failed one:
 * dropping a scanner from the wiring can never quietly open the gate.
 */
export function scanGateDecision(
  results: readonly ScanResult[],
  required: readonly ScanTool[] = CORE_SCAN_TOOLS,
): ScanGateDecision {
  const missing: ScanTool[] = [];
  const blockingTools: ScanTool[] = [];
  const reasons: string[] = [];

  for (const tool of required) {
    if (!results.some((result) => result.tool === tool)) {
      missing.push(tool);
      reasons.push(`${tool}: no result — a required scan did not run`);
    }
  }
  // Optional drivers (M77) are not required, but once they ran they count.
  for (const result of results.filter((candidate) => isScanBlocking(candidate.outcome))) {
    blockingTools.push(result.tool);
    reasons.push(`${result.tool}: ${result.outcome}${detailOf(result)}`);
  }
  return { blocking: missing.length > 0 || blockingTools.length > 0, missing, blockingTools, reasons };
}

/** One file per tool: the raw, contract-shaped result (M34). */
export function scanResultArtifact(result: ScanResult): EvidenceArtifact {
  return {
    name: `${SCAN_EVIDENCE_DIR}/${result.tool}.json`,
    contentType: "application/json",
    body: `${JSON.stringify(result, null, 2)}\n`,
  };
}

/**
 * Summary sheet for the evidence package. Label-free on purpose: columns are
 * contract field names, so it needs no locale — prose is M104's job.
 */
export function scanSummaryArtifact(
  results: readonly ScanResult[],
  required: readonly ScanTool[] = CORE_SCAN_TOOLS,
): EvidenceArtifact {
  const decision = scanGateDecision(results, required);
  const lines = [
    "# scan-summary (M27)",
    "",
    `blocking: ${decision.blocking ? "yes" : "no"}`,
    "",
    `| tool | outcome | imageDigest | ${SEVERITY_ORDER.join(" | ")} |`,
    `|---|---|---|${SEVERITY_ORDER.map(() => "---").join("|")}|`,
  ];

  for (const tool of [...required, ...results.map((r) => r.tool).filter((t) => !required.includes(t))]) {
    const result = results.find((candidate) => candidate.tool === tool);
    if (!result) {
      lines.push(`| ${tool} | MISSING | - | ${SEVERITY_ORDER.map(() => "-").join(" | ")} |`);
      continue;
    }
    const counts = countBySeverity(result.findings);
    const cells = SEVERITY_ORDER.map((severity) => String(counts[severity])).join(" | ");
    lines.push(`| ${tool} | ${result.outcome} | ${result.imageDigest} | ${cells} |`);
  }

  if (decision.reasons.length > 0) {
    lines.push("", "## blocking", ...decision.reasons.map((reason) => `- ${reason}`));
  }
  return { name: `${SCAN_EVIDENCE_DIR}/summary.md`, contentType: "text/markdown", body: `${lines.join("\n")}\n` };
}

/** Every artifact of a run: one file per result plus the summary. */
export function scanEvidenceArtifacts(
  results: readonly ScanResult[],
  required: readonly ScanTool[] = CORE_SCAN_TOOLS,
): EvidenceArtifact[] {
  return [...results.map(scanResultArtifact), scanSummaryArtifact(results, required)];
}

function detailOf(result: ScanResult): string {
  const error = result.findings.find((finding) => finding.ruleId === SCAN_ERROR_RULE_ID);
  if (error) return ` — ${error.message}`;
  return result.findings.length > 0 ? ` — ${result.findings.length} finding(s)` : "";
}

/** Manifest entry (`EvidencePackage.files`) for an artifact. */
export function toEvidenceFile(artifact: EvidenceArtifact): EvidenceFile {
  return EvidenceFile.parse({
    name: artifact.name,
    sha256: createHash("sha256").update(artifact.body, "utf8").digest("hex"),
    bytes: Buffer.byteLength(artifact.body, "utf8"),
    contentType: artifact.contentType,
  });
}
