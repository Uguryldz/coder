import { createProtectedPathMatcher, normalizeRepoPath, type ProtectedPathMatcher } from "@maestro/execution";
import { ToolPolicyError } from "./errors.js";

export type { ProtectedPathMatcher };

/**
 * The M52 matcher, reused verbatim from `@maestro/execution` rather than
 * re-implemented here. Two glob engines mean two deny-lists, and the day they
 * disagree is the day the tool allows a write the post-session gate would have
 * stopped. `createProtectedPathMatcher` also unions the repo's list with the
 * defaults, so an empty `protected_paths:` in `.maestro.yaml` cannot switch
 * migrations and secrets off.
 */
export function workspaceMatcher(extraPatterns: readonly string[] = []): ProtectedPathMatcher {
  return createProtectedPathMatcher(extraPatterns);
}

/**
 * Control characters have no business in a path: a NUL truncates the name at
 * the syscall boundary, so a request for `secrets/key.pem\0.txt` would face a
 * deny-list that only saw the harmless-looking `.txt` tail. Checked by code
 * point rather than by regex — a literal control character inside a regex
 * literal is unreviewable.
 */
function hasControlChars(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Turns a model-supplied path into a workspace-relative path, or refuses.
 *
 * Two separate refusals, in this order:
 *  1. **escape** — absolute paths, drive letters, `..` segments, control
 *     characters. `/etc/shadow` and `../../id_rsa` are not protected-path
 *     violations, they are attempts to leave the sandbox, and they are refused
 *     for every operation including reads.
 *  2. **protected path (M52)** — only for writes. Reading a migration is how
 *     an agent understands a schema; writing one is the change M52 exists to
 *     stop.
 */
export function guardWorkspacePath(
  tool: string,
  matcher: ProtectedPathMatcher,
  rawPath: string,
  mode: "read" | "write",
): string {
  if (hasControlChars(rawPath)) {
    throw new ToolPolicyError(tool, "path_escape", `${tool}: path contains control characters`);
  }
  let path: string;
  try {
    path = normalizeRepoPath(rawPath);
  } catch (cause) {
    throw new ToolPolicyError(
      tool,
      "path_escape",
      `${tool}: "${rawPath}" is not inside the sandbox workspace (${
        cause instanceof Error ? cause.message : String(cause)
      })`,
    );
  }
  if (mode === "write") {
    const pattern = matcher.match(path);
    if (pattern !== null) {
      // M52, at the tool boundary: the write does not happen, so there is no
      // illegal diff to catch afterwards.
      throw new ToolPolicyError(
        tool,
        "protected_path",
        `${tool}: "${path}" is a protected path (rule "${pattern}"); a human must make this change (M52)`,
      );
    }
  }
  return path;
}
