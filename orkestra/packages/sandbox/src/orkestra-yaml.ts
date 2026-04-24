import { createLogger } from "@orkestra/config";
import { OrkestraYamlConfig } from "@orkestra/contracts";
import yaml from "js-yaml";
import { readFile } from "node:fs/promises";
import path from "node:path";

const log = createLogger("sandbox.orkestra-yaml");

export type SupportedLanguage = "node" | "python" | "java" | "go";

/**
 * Parse `.orkestra.yaml` contents and validate against Zod schema.
 * Throws descriptive error on failure.
 */
export function parseOrkestraYaml(content: string): OrkestraYamlConfig {
  let raw: unknown;
  try {
    raw = yaml.load(content);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`[orkestra-yaml] YAML parse failed: ${msg}`);
  }

  const parsed = OrkestraYamlConfig.safeParse(raw);
  if (!parsed.success) {
    const flat = parsed.error.flatten();
    throw new Error(
      `[orkestra-yaml] schema validation failed: ${JSON.stringify(flat.fieldErrors)}`,
    );
  }
  return parsed.data;
}

/**
 * Load `.orkestra.yaml` from the root of a repository path.
 */
export async function loadOrkestraYaml(repoPath: string): Promise<OrkestraYamlConfig> {
  const p = path.join(repoPath, ".orkestra.yaml");
  log.debug({ path: p }, "loading orkestra yaml");
  const buf = await readFile(p, "utf8");
  return parseOrkestraYaml(buf);
}

/**
 * Reasonable defaults per language when a repo has no `.orkestra.yaml` yet.
 * These are MVP starting points; they can (and should) be overridden per repo.
 */
export function defaultOrkestraYaml(language: SupportedLanguage): OrkestraYamlConfig {
  const base = {
    clone_depth: 50,
    test_dependencies: [],
    cache_paths: [],
    env_secrets: [],
    coverage_threshold: 70,
  };

  switch (language) {
    case "node":
      return OrkestraYamlConfig.parse({
        ...base,
        language: "node",
        sandbox_image: "node:20-bookworm-slim",
        commands: {
          install: "npm ci --no-audit --no-fund",
          lint: "npm run -s lint",
          build: "npm run -s build",
          test_unit: "npm run -s test",
          test_integration: "npm run -s test:integration",
          coverage: "npm run -s coverage",
        },
        cache_paths: ["node_modules", "~/.npm"],
      });
    case "python":
      return OrkestraYamlConfig.parse({
        ...base,
        language: "python",
        sandbox_image: "python:3.12-slim",
        commands: {
          install: "pip install --no-cache-dir -r requirements.txt",
          lint: "ruff check .",
          build: "python -m compileall -q .",
          test_unit: "pytest -q tests/unit",
          test_integration: "pytest -q tests/integration",
          coverage: "pytest --cov=.",
        },
        cache_paths: [".venv", "~/.cache/pip"],
      });
    case "java":
      return OrkestraYamlConfig.parse({
        ...base,
        language: "java",
        sandbox_image: "maven:3.9-eclipse-temurin-21",
        commands: {
          install: "mvn -B -q -DskipTests dependency:go-offline",
          lint: "mvn -B -q spotless:check",
          build: "mvn -B -q -DskipTests package",
          test_unit: "mvn -B -q test",
          test_integration: "mvn -B -q verify -DskipUTs",
          coverage: "mvn -B -q jacoco:report",
        },
        cache_paths: ["~/.m2/repository"],
      });
    case "go":
      return OrkestraYamlConfig.parse({
        ...base,
        language: "go",
        sandbox_image: "golang:1.23-bookworm",
        commands: {
          install: "go mod download",
          lint: "go vet ./...",
          build: "go build ./...",
          test_unit: "go test ./...",
          test_integration: "go test -tags=integration ./...",
          coverage: "go test -coverprofile=coverage.out ./...",
        },
        cache_paths: ["~/go/pkg/mod", "~/.cache/go-build"],
      });
  }
}
