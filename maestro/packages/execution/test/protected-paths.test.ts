import { describe, expect, it } from "vitest";
import { ExecutionConfigError, ProtectedPathViolationError } from "../src/errors.js";
import {
  assertNoProtectedChanges,
  compileProtectedPath,
  createProtectedPathMatcher,
  DEFAULT_PROTECTED_PATHS,
  findProtectedViolations,
  normalizeRepoPath,
} from "../src/protected-paths.js";
import { changed } from "./helpers.js";

describe("compileProtectedPath", () => {
  const cases: Array<[string, string, boolean]> = [
    ["**/migrations/**", "db/migrations/001.sql", true],
    ["**/migrations/**", "migrations/001.sql", true],
    ["**/migrations/**", "src/migrationsx/a.ts", false],
    ["db/*.sql", "db/a.sql", true],
    ["db/*.sql", "db/sub/a.sql", false],
    ["**/*.pem", "certs/deep/key.pem", true],
    [".maestro.yaml", ".maestro.yaml", true],
    [".maestro.yaml", "sub/.maestro.yaml", false],
    ["src/a?.ts", "src/ab.ts", true],
    ["src/a?.ts", "src/abc.ts", false],
  ];
  for (const [pattern, path, expected] of cases) {
    it(`${pattern} ${expected ? "matches" : "does not match"} ${path}`, () => {
      expect(compileProtectedPath(pattern).test(path)).toBe(expected);
    });
  }

  it("treats a dot as a literal, not as 'any character'", () => {
    expect(compileProtectedPath("**/.env").test("xenv")).toBe(false);
    expect(compileProtectedPath("**/.env").test("app/.env")).toBe(true);
  });

  it("refuses patterns it cannot honour rather than matching nothing", () => {
    expect(() => compileProtectedPath("")).toThrow(ExecutionConfigError);
    expect(() => compileProtectedPath("/etc/passwd")).toThrow(/repo-relative/);
    expect(() => compileProtectedPath("C:/secrets")).toThrow(/repo-relative/);
    expect(() => compileProtectedPath("db\\migrations")).toThrow(/forward slashes/);
  });
});

describe("normalizeRepoPath", () => {
  it("normalises the shapes a probe may produce", () => {
    expect(normalizeRepoPath("./src/a.ts")).toBe("src/a.ts");
    expect(normalizeRepoPath("src\\a.ts")).toBe("src/a.ts");
  });

  it("rejects a change that is not inside the workspace", () => {
    expect(() => normalizeRepoPath("/etc/passwd")).toThrow(/absolute/);
    expect(() => normalizeRepoPath("../../etc/passwd")).toThrow(/escapes the workspace/);
    expect(() => normalizeRepoPath("  ")).toThrow(ExecutionConfigError);
  });
});

describe("findProtectedViolations", () => {
  const matcher = createProtectedPathMatcher(["**/migrations/**", "**/secrets/**"]);

  it("passes an ordinary change", () => {
    expect(findProtectedViolations([changed("src/pay/mapper.ts")], matcher)).toEqual([]);
  });

  it("names the file and the rule that caught it", () => {
    const violations = findProtectedViolations(
      [changed("src/a.ts"), changed("db/migrations/002.sql", { status: "added" })],
      matcher,
    );
    expect(violations).toEqual([
      { path: "db/migrations/002.sql", pattern: "**/migrations/**", status: "added" },
    ]);
  });

  it("catches a deletion, not only an edit", () => {
    const violations = findProtectedViolations([changed("app/secrets/keys.json", { status: "deleted" })], matcher);
    expect(violations[0]?.status).toBe("deleted");
  });
});

describe("assertNoProtectedChanges", () => {
  it("stays quiet when nothing protected moved", () => {
    expect(() =>
      assertNoProtectedChanges([changed("src/a.ts")], createProtectedPathMatcher(DEFAULT_PROTECTED_PATHS)),
    ).not.toThrow();
  });

  it("throws with the offending paths so the handover can name them (M52)", () => {
    const matcher = createProtectedPathMatcher(DEFAULT_PROTECTED_PATHS);
    const error = (() => {
      try {
        assertNoProtectedChanges([changed("api/.env"), changed("db/migrations/003.sql")], matcher);
        return null;
      } catch (e) {
        return e as ProtectedPathViolationError;
      }
    })();
    expect(error).toBeInstanceOf(ProtectedPathViolationError);
    expect(error?.violations).toHaveLength(2);
    expect(error?.message).toContain("api/.env");
    expect(error?.message).toContain("db/migrations/003.sql");
  });

  it("protects migrations and secrets out of the box (M52 defaults)", () => {
    const matcher = createProtectedPathMatcher(DEFAULT_PROTECTED_PATHS);
    for (const path of ["db/migrations/1.sql", "app/secrets/a.txt", ".env", "svc/.env.prod", "tls/server.key"]) {
      expect(matcher.match(path)).not.toBeNull();
    }
  });

  it("rejects a compiled matcher built from an unusable pattern at construction time", () => {
    expect(() => createProtectedPathMatcher(["/abs"])).toThrow(ExecutionConfigError);
  });
});
