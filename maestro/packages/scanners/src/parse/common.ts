import type { ScanFinding, ScanSeverity } from "@maestro/contracts";
import type { z } from "zod";
import { ScanParseError } from "../errors.js";

export interface ParsedScan {
  findings: ScanFinding[];
  /** The tool reported it could not complete — the driver makes it `error` (M27). */
  fatal?: string;
}

/** Everything a parser needs from configuration. */
export interface ParseContext {
  secretSeverity: ScanSeverity;
}

/**
 * Every parser starts here: unreadable output is an exception, never an empty
 * finding list. "It produced nothing, so it passed" is what M27 forbids.
 */
export function parseJson(tool: string, stdout: string): unknown {
  const text = stdout.trim();
  if (text === "") throw new ScanParseError(`${tool}: produced no output — nothing to interpret`);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ScanParseError(`${tool}: output is not JSON — ${(error as Error).message}`);
  }
}

export function parseWith<T>(tool: string, schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issues = result.error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  throw new ScanParseError(`${tool}: report does not match the expected schema — ${issues}`);
}

/** `ScanFinding.message` is a non-empty string; tools do not always fill theirs. */
export function messageOr(fallback: string, ...candidates: (string | undefined)[]): string {
  for (const candidate of candidates) {
    const text = candidate?.trim();
    if (text) return text;
  }
  return fallback;
}

export function optionalText(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text === "" ? undefined : text;
}

/** `ScanFinding.line` is a positive integer; 0 means "the tool did not say". */
export function optionalLine(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}
