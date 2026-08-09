import { ExecutionConfigError } from "./errors.js";
import type { ChangedFile, ChangeStatus } from "./types.js";

/**
 * M52: a repo-level deny-list in `.maestro.yaml`. If the agent produced a diff
 * under a protected path the flow stops and a human takes over — so this file
 * is fail-closed everywhere: an unusable pattern, an unreadable path and an
 * unknown shape are all violations or errors, never "no match".
 */

/**
 * The floor, not the whole list. `createProtectedPathMatcher` UNIONs these
 * with whatever the repo configured; a repo can add to them and can never
 * shrink them. M52 words it as "migrations + secrets are protected by
 * default", and a default that an empty `protected_paths:` switches off is not
 * a default — it is a fail-open switch on the gate.
 */
export const DEFAULT_PROTECTED_PATHS: readonly string[] = [
  // M52, verbatim: migrations and secrets.
  "**/migrations/**",
  "**/*.sql",
  "**/secrets/**",
  "**/.env",
  "**/.env.*",
  "**/*.pem",
  "**/*.key",
  "**/*.p12",
  "**/*.pfx",
  "**/*.jks",
  "**/id_rsa*",
  "**/.npmrc",
  // The runner's own execution surface. A change here does not need to wait
  // for a merge to run code on the build machine.
  ".git/**",
  ".github/**",
  ".gitlab-ci.yml",
  "Jenkinsfile",
  ".claude/**",
  "**/.claude/**",
  ".maestro.yaml",
  // NOTE — lockfiles are deliberately NOT here (orchestrator decision, M53).
  // A lockfile edit can repoint a package at an attacker's tarball, but M53's
  // control is "a dependency outside the approved list needs Tech Lead
  // approval", i.e. it is FLAGGED at the human gate, not refused mid-session.
  // Blocking here would make every routine version bump impossible for the
  // agent — the very work it is meant to do. The flagging path belongs to the
  // PR step (wave 3) and to `@maestro/scanners`.
];

/**
 * Characters a pattern may contain besides the glob metacharacters `*?/`.
 * Deliberately a WHITE-list: the compiler used to escape everything it did not
 * understand, so `**` + `/*.{sql,ddl}` compiled to a regex looking for a
 * literal `{sql,ddl}` and matched no `.sql` file at all. A deny-list entry that
 * matches nothing is the most dangerous thing this file can produce, because
 * it reads as protection in review and provides none at runtime.
 */
const ALLOWED_LITERAL = /[A-Za-z0-9._-]/;

/**
 * Glob subset, written out rather than pulled from a dependency: `**` (any
 * number of segments), `*` (within one segment), `?`. A pattern needing more is
 * refused at load, so nobody discovers at review time that theirs matched
 * nothing.
 */
export function compileProtectedPath(pattern: string): RegExp {
  const trimmed = pattern.trim().normalize("NFC");
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
    if (ch === "/") {
      source += "/";
      continue;
    }
    if (!ALLOWED_LITERAL.test(ch)) {
      throw new ExecutionConfigError(
        `protected path "${pattern}" uses unsupported syntax at "${ch}"; only * ? / and [A-Za-z0-9._-] are honoured`,
      );
    }
    source += ch.replace(/[.]/g, "\\$&");
  }
  // `i`: a deny-list may over-match safely and must not be walked past with
  // `db/Migrations/001.SQL` on a case-insensitive filesystem.
  return new RegExp(`^${source}$`, "i");
}

export interface ProtectedPathMatcher {
  readonly patterns: readonly string[];
  /** Returns the pattern that caught the path, or null. */
  match(path: string): string | null;
}

/** Normalise to the shape patterns are written in; reject anything escaping. */
export function normalizeRepoPath(path: string): string {
  // NFC: macOS hands back decomposed names, and a composed pattern does not
  // match a decomposed path even though both print identically.
  const cleaned = path.trim().replace(/\\/g, "/").replace(/^\.\//, "").normalize("NFC");
  if (cleaned === "") throw new ExecutionConfigError("changed file path is empty");
  if (cleaned.startsWith("/") || /^[A-Za-z]:/.test(cleaned)) {
    throw new ExecutionConfigError(`changed file "${path}" is absolute; expected workspace-relative`);
  }
  if (cleaned.split("/").includes("..")) {
    throw new ExecutionConfigError(`changed file "${path}" escapes the workspace`);
  }
  return cleaned;
}

/**
 * Builds the matcher for a repo. `extraPatterns` ADDS to
 * `DEFAULT_PROTECTED_PATHS`; there is deliberately no way to build a matcher
 * without them.
 */
export function createProtectedPathMatcher(extraPatterns: readonly string[] = []): ProtectedPathMatcher {
  const patterns = [...new Set([...DEFAULT_PROTECTED_PATHS, ...extraPatterns])];
  const compiled = patterns.map((pattern) => ({ pattern, regex: compileProtectedPath(pattern) }));
  return {
    patterns,
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
  readonly status: ChangeStatus;
}

/** Which of this session's changes landed on protected ground, and under which rule. */
export function findProtectedViolations(
  changed: readonly ChangedFile[],
  matcher: ProtectedPathMatcher,
): ProtectedPathViolation[] {
  const violations: ProtectedPathViolation[] = [];
  for (const file of changed) {
    // Both ends of a rename: moving a file ONTO protected ground and moving one
    // OFF it are each a single git entry, and only one of the two paths is the
    // entry's `path`.
    for (const candidate of file.fromPath === undefined ? [file.path] : [file.path, file.fromPath]) {
      const pattern = matcher.match(candidate);
      if (pattern !== null) violations.push({ path: candidate, pattern, status: file.status });
    }
  }
  return violations;
}
