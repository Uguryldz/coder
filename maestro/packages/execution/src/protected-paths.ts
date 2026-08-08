import { ExecutionConfigError, ProtectedPathViolationError } from "./errors.js";
import type { ChangedFile } from "./types.js";

/**
 * M52: a repo-level deny-list in `.maestro.yaml`. If the agent produced a diff
 * under a protected path the flow stops and a human takes over — so this file
 * is fail-closed everywhere: an unusable pattern, an unreadable path and an
 * unknown shape are all violations or errors, never "no match".
 *
 * The defaults are the two M52 names outright: migrations and secrets.
 */
export const DEFAULT_PROTECTED_PATHS: readonly string[] = [
  "**/migrations/**",
  "**/*.sql",
  "**/secrets/**",
  "**/.env",
  "**/.env.*",
  "**/*.pem",
  "**/*.key",
  ".maestro.yaml",
];

/**
 * Glob subset, written out rather than pulled from a dependency: `**` (any
 * number of segments), `*` (within one segment), `?`. A pattern needing more is
 * refused at load, so nobody discovers at review time that theirs matched
 * nothing.
 */
export function compileProtectedPath(pattern: string): RegExp {
  const trimmed = pattern.trim();
  if (trimmed === "") throw new ExecutionConfigError("protected path pattern is empty");
  if (trimmed.startsWith("/") || /^[A-Za-z]:/.test(trimmed)) {
    throw new ExecutionConfigError(`protected path "${pattern}" must be repo-relative`);
  }
  if (trimmed.includes("\\")) {
    throw new ExecutionConfigError(`protected path "${pattern}" must use forward slashes`);
  }
  let source = "";
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i] as string;
    if (ch === "*" && trimmed[i + 1] === "*") {
      // `**/` matches zero segments too, so `**/migrations/**` also catches a
      // top-level `migrations/x.sql`.
      const slash = trimmed[i + 2] === "/";
      source += slash ? "(?:[^/]+/)*" : ".*";
      i += slash ? 2 : 1;
      continue;
    }
    if (ch === "*") {
      source += "[^/]*";
      continue;
    }
    if (ch === "?") {
      source += "[^/]";
      continue;
    }
    source += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

export interface ProtectedPathMatcher {
  readonly patterns: readonly string[];
  /** Returns the pattern that caught the path, or null. */
  match(path: string): string | null;
}

/** Normalise to the shape patterns are written in; reject anything escaping. */
export function normalizeRepoPath(path: string): string {
  const cleaned = path.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (cleaned === "") throw new ExecutionConfigError("changed file path is empty");
  if (cleaned.startsWith("/") || /^[A-Za-z]:/.test(cleaned)) {
    throw new ExecutionConfigError(`changed file "${path}" is absolute; expected workspace-relative`);
  }
  if (cleaned.split("/").includes("..")) {
    throw new ExecutionConfigError(`changed file "${path}" escapes the workspace`);
  }
  return cleaned;
}

export function createProtectedPathMatcher(patterns: readonly string[]): ProtectedPathMatcher {
  const compiled = patterns.map((pattern) => ({ pattern, regex: compileProtectedPath(pattern) }));
  return {
    patterns: [...patterns],
    match(path: string): string | null {
      const normalized = normalizeRepoPath(path);
      for (const { pattern, regex } of compiled) {
        if (regex.test(normalized)) return pattern;
      }
      return null;
    },
  };
}

export interface ProtectedPathViolation {
  readonly path: string;
  readonly pattern: string;
  readonly status: ChangedFile["status"];
}

/** Which of this session's changes landed on protected ground, and under which rule. */
export function findProtectedViolations(
  changed: readonly ChangedFile[],
  matcher: ProtectedPathMatcher,
): ProtectedPathViolation[] {
  const violations: ProtectedPathViolation[] = [];
  for (const file of changed) {
    const pattern = matcher.match(file.path);
    if (pattern !== null) violations.push({ path: file.path, pattern, status: file.status });
  }
  return violations;
}

/**
 * The gate itself, run at the END of a session (M52). It throws: a caller that
 * forgets to read a returned boolean is the failure mode this avoids.
 */
export function assertNoProtectedChanges(
  changed: readonly ChangedFile[],
  matcher: ProtectedPathMatcher,
): void {
  const violations = findProtectedViolations(changed, matcher);
  if (violations.length === 0) return;
  throw new ProtectedPathViolationError(violations.map((v) => `${v.path} (matched ${v.pattern})`));
}
