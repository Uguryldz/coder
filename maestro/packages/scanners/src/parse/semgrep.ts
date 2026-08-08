import type { ScanFinding, ScanSeverity } from "@maestro/contracts";
import { z } from "zod";
import { messageOr, optionalLine, optionalText, parseJson, parseWith, type ParsedScan } from "./common.js";

/**
 * semgrep `--json`: `{ version, results[], errors[], paths, … }`; a result is
 * `{ check_id, path, start:{line,col}, end, extra:{ message, severity, … } }`.
 */
const SemgrepResult = z.looseObject({
  check_id: z.string().min(1),
  path: z.string().optional(),
  start: z.looseObject({ line: z.number().int().optional() }).optional(),
  extra: z.looseObject({
    message: z.string().optional(),
    severity: z.string().optional(),
    metadata: z.looseObject({ severity: z.string().optional() }).optional(),
    is_ignored: z.boolean().optional(),
  }),
});

/** `errors[]` entries carry `level` ("error" / "warn") and a `message`. */
const SemgrepError = z.looseObject({
  level: z.string().optional(),
  message: z.string().optional(),
  type: z.unknown().optional(),
});

const SemgrepReport = z.looseObject({
  results: z.array(SemgrepResult),
  errors: z.array(SemgrepError).optional(),
});

/** `extra.severity` — semgrep's own rule levels. */
const RESULT_SEVERITY: Record<string, ScanSeverity> =
  { ERROR: "high", WARNING: "medium", INFO: "low", INVENTORY: "info", EXPERIMENT: "info" };

/** `extra.metadata.severity` — the rule author's grading, when present. */
const METADATA_SEVERITY: Record<string, ScanSeverity> =
  { CRITICAL: "critical", HIGH: "high", MEDIUM: "medium", LOW: "low", INFO: "info" };

/** Levels in `errors[]` that are advisory rather than a failed run. */
const NON_FATAL_LEVELS = new Set(["warn", "warning", "info"]);

/** Unknown grading is serious, not noise: a new label must not land under every threshold. */
const UNKNOWN_SEVERITY: ScanSeverity = "high";

export function semgrepSeverity(result: {
  extra: { severity?: string; metadata?: { severity?: string } };
}): ScanSeverity {
  const authored = METADATA_SEVERITY[result.extra.metadata?.severity?.toUpperCase() ?? ""];
  if (authored) return authored;
  const level = result.extra.severity?.toUpperCase() ?? "";
  return RESULT_SEVERITY[level] ?? UNKNOWN_SEVERITY;
}

export function parseSemgrep(stdout: string): ParsedScan {
  const report = parseWith("semgrep", SemgrepReport, parseJson("semgrep", stdout));

  const findings: ScanFinding[] = report.results
    .filter((result) => result.extra.is_ignored !== true)
    .map((result) => ({
      tool: "semgrep" as const,
      severity: semgrepSeverity(result),
      ruleId: result.check_id,
      file: optionalText(result.path),
      line: optionalLine(result.start?.line),
      message: messageOr(`semgrep rule ${result.check_id} matched`, result.extra.message),
    }));

  // A rule that failed to run scanned nothing, so its absence of findings means
  // nothing either — the whole scan is an error, not a pass (M27).
  const fatal = (report.errors ?? [])
    .filter((error) => !NON_FATAL_LEVELS.has((error.level ?? "error").toLowerCase()))
    .map((error) => messageOr("semgrep reported an unlabelled error", error.message));

  return fatal.length > 0
    ? { findings, fatal: `semgrep reported ${fatal.length} error(s): ${fatal[0]}` }
    : { findings };
}
