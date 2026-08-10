import { readFileSync } from "node:fs";
import { parseDotEnv } from "@maestro/secrets";

/**
 * Reads `maestro/.env` (git-ignored) with the same parser the env-file secret
 * driver uses. Values are returned, never printed: the only consumers are the
 * OpenRouter resolver and the SecretPort seed built in secrets.ts.
 */
export function loadRepoEnv(): Record<string, string> {
  const path = new URL("../../../.env", import.meta.url);
  try {
    return parseDotEnv(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

export interface OpenRouterEnv {
  apiKey: string;
  /**
   * Base URL WITHOUT the `/v1` suffix: the `openai-compat` driver appends
   * `/v1/chat/completions` itself.
   */
  baseUrl: string;
}

/**
 * Resolves the OpenRouter credentials. Fails loudly and in Turkish — a pilot
 * that silently runs without a model would be the "fake success" this repo
 * refuses everywhere else.
 */
export function resolveOpenRouter(env: Record<string, string>): OpenRouterEnv {
  const apiKey = process.env["OPENROUTER_API_KEY"] ?? env["OPENROUTER_API_KEY"] ?? "";
  if (apiKey.trim().length === 0) {
    throw new Error(
      "OPENROUTER_API_KEY bulunamadı. maestro/.env dosyasına OPENROUTER_API_KEY=... satırını ekleyin.",
    );
  }
  const raw = process.env["OPENROUTER_BASE_URL"] ?? env["OPENROUTER_BASE_URL"] ?? "https://openrouter.ai/api";
  return { apiKey: apiKey.trim(), baseUrl: raw.trim().replace(/\/+$/, "").replace(/\/v1$/, "") };
}

export interface JiraCloudEnv {
  baseUrl: string;
  email: string;
  /** The Atlassian API token — NEVER logged; handed straight to the SecretPort. */
  apiToken: string;
}

/**
 * Resolves the LIVE Jira Cloud credentials from the environment. These three
 * already exist in `maestro/.env`. Missing any of them is a hard, loud failure
 * — the whole point of the pilot is to talk to the real site, so we never fall
 * back to a fake.
 */
export function resolveJiraCloud(env: Record<string, string>): JiraCloudEnv {
  const get = (key: string): string => (process.env[key] ?? env[key] ?? "").trim();
  const baseUrl = get("JIRA_CLOUD_BASE_URL");
  const email = get("JIRA_CLOUD_EMAIL");
  const apiToken = get("JIRA_CLOUD_API_TOKEN");

  const missing = [
    baseUrl.length === 0 ? "JIRA_CLOUD_BASE_URL" : null,
    email.length === 0 ? "JIRA_CLOUD_EMAIL" : null,
    apiToken.length === 0 ? "JIRA_CLOUD_API_TOKEN" : null,
  ].filter((name): name is string => name !== null);
  if (missing.length > 0) {
    throw new Error(
      `Canlı Jira için ${missing.join(", ")} eksik. maestro/.env dosyasına ekleyin (pilot gerçek siteye bağlanır).`,
    );
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ""), email, apiToken };
}
