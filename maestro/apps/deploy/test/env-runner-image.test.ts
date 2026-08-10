import { describe, expect, it } from "vitest";
import { loadDeployEnv } from "../src/env.js";

/**
 * `RUNNER_IMAGE_LINUX` as compose actually delivers it.
 *
 * compose.yaml passes `${RUNNER_IMAGE_LINUX:-}`, which sends an EMPTY STRING
 * when the operator has not set one — not an absent variable. That distinction
 * is the whole test: `z.string().min(1).optional()` accepts absent and rejects
 * empty, so an unset runner image would take the entire worker down at boot
 * with a validation error, instead of leaving step 6a with its narrow,
 * documented refusal.
 *
 * The variable was missing from the compose anchor before this change, so this
 * path had never been exercised.
 */

const MINIMAL: Record<string, string> = {
  NODE_ENV: "development",
  DATABASE_URL: "postgresql://maestro:x@localhost:5432/maestro",
  JIRA_BASE_URL: "https://jira.example.local",
  ADO_BASE_URL: "https://dev.azure.com",
  LLM_BASE_URL: "https://llm.example.local/v1",
  STORAGE_ENDPOINT: "https://s3.example.local",
  VAULT_ADDR: "https://vault.example.local",
};

describe("RUNNER_IMAGE_LINUX", () => {
  it("is optional — a deployment with no sandbox fleet still boots", () => {
    const env = loadDeployEnv({ ...MINIMAL });
    expect(env.RUNNER_IMAGE_LINUX).toBeUndefined();
  });

  it("treats compose's empty default as UNSET rather than refusing to boot", () => {
    // `${RUNNER_IMAGE_LINUX:-}` with nothing set → "".
    const env = loadDeployEnv({ ...MINIMAL, RUNNER_IMAGE_LINUX: "" });
    expect(env.RUNNER_IMAGE_LINUX).toBeUndefined();
  });

  it("carries a digest-pinned image through when one is set", () => {
    const pinned = "registry.bank.local/maestro/runner-linux@sha256:" + "a".repeat(64);
    const env = loadDeployEnv({ ...MINIMAL, RUNNER_IMAGE_LINUX: pinned });
    expect(env.RUNNER_IMAGE_LINUX).toBe(pinned);
  });
});
