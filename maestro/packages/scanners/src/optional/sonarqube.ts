import { ScanSeverity, type ScanFinding } from "@maestro/contracts";
import { CapabilityNotSupportedError } from "@maestro/ports";
import { z } from "zod";
import { DEFAULT_BLOCK_LEVEL, SCAN_PORT } from "../config.js";
import { ScanConfigError } from "../errors.js";
import { messageOr, optionalLine, optionalText, parseJson, parseWith, type ParsedScan } from "../parse/common.js";
import type { Clock } from "../runner.js";
import { depsOf } from "./fortify.js";
import { HttpScanPort, isUnconfigured, parseConfig, requireHttps, type FetchLike } from "./http-scan.js";

/**
 * SonarQube driver (M77, optional): reads a project's open issues via
 * `GET /api/issues/search`; the analysis itself runs in the project's pipeline.
 * Bearer auth is SonarQube 9.x+ — older servers want Basic (RAPOR.md).
 */
export const SonarQubeConfig = z.object({
  baseUrl: z.url(),
  projectKey: z.string().trim().min(1),
  blockLevel: ScanSeverity.default(DEFAULT_BLOCK_LEVEL),
  pageSize: z.number().int().positive().max(500).default(500),
  timeoutMs: z.number().int().positive().max(300_000).default(30_000),
});
export type SonarQubeConfig = z.infer<typeof SonarQubeConfig>;

export interface SonarQubeDeps {
  token?: string;
  fetchImpl?: FetchLike;
  clock?: Clock;
}

/** `{ total, p, ps, issues: [{ key, rule, severity, component, line, message }] }`. */
const SonarIssue = z.looseObject({
  rule: z.string().optional(),
  key: z.string().optional(),
  severity: z.string().optional(),
  component: z.string().optional(),
  line: z.number().int().optional(),
  message: z.string().optional(),
});

const SonarIssueSearch = z.looseObject({
  issues: z.array(SonarIssue).nullish(),
  total: z.number().int().optional(),
});

const SONAR_SEVERITY: Record<string, ScanSeverity> =
  { BLOCKER: "critical", CRITICAL: "high", MAJOR: "medium", MINOR: "low", INFO: "info" };

export function parseSonarQube(body: string): ParsedScan {
  const report = parseWith("sonarqube", SonarIssueSearch, parseJson("sonarqube", body));

  const findings: ScanFinding[] = (report.issues ?? []).map((issue) => ({
    tool: "sonarqube" as const,
    severity: SONAR_SEVERITY[issue.severity?.toUpperCase() ?? ""] ?? "high",
    ruleId: messageOr("sonarqube.issue", issue.rule, issue.key),
    // `component` is "<projectKey>:<path>"; the path is what a reviewer needs.
    file: optionalText(issue.component?.slice(issue.component.indexOf(":") + 1)),
    line: optionalLine(issue.line),
    message: messageOr(messageOr("sonarqube issue", issue.rule), issue.message),
  }));
  return { findings };
}

/** @throws CapabilityNotSupportedError when SonarQube is not configured (M77). */
export function createSonarQubeScanPort(input: unknown, deps: SonarQubeDeps = {}): HttpScanPort {
  if (isUnconfigured(input)) throw new CapabilityNotSupportedError(SCAN_PORT, "sonarqube");

  const config = parseConfig("sonarqube", SonarQubeConfig, input);
  const merged = { ...deps, ...depsOf<SonarQubeDeps>(input) };
  const token = merged.token?.trim();
  if (!token) throw new ScanConfigError("sonarqube: deps.token is required");
  const baseUrl = requireHttps("sonarqube", config.baseUrl);

  return new HttpScanPort({
    spec: {
      tool: "sonarqube",
      provenance: `sonarqube:${config.projectKey}`,
      blockLevel: config.blockLevel,
      timeoutMs: config.timeoutMs,
      url: () =>
        `${baseUrl}/api/issues/search?componentKeys=${encodeURIComponent(config.projectKey)}` +
        `&resolved=false&ps=${config.pageSize}&p=1`,
      headers: () => ({ Authorization: `Bearer ${token}`, Accept: "application/json" }),
      parse: parseSonarQube,
    },
    fetchImpl: merged.fetchImpl,
    clock: merged.clock,
  });
}
