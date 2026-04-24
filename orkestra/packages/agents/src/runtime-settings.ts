/**
 * Runtime credential resolver.
 *
 * Tüm external bağlantılar (Jira, Git, Claude) için credential'ları şu
 * sırayla çözer:
 *   1. DB Setting tablosu (Settings UI'dan kaydedilen)
 *   2. Environment variable (.env / docker-compose env)
 *   3. Default değer (boş / hata)
 *
 * Böylece UI'dan kaydet + worker anında okur — env redeploy gerekmez.
 */
import { loadConfig } from "@orkestra/config";
import { getDb } from "@orkestra/db";

async function loadSetting<T>(key: string): Promise<T | null> {
  try {
    const db = getDb();
    const s = await db.setting.findUnique({ where: { key } });
    if (!s) return null;
    return (s.value as T | null) ?? null;
  } catch {
    return null;
  }
}

export interface ClaudeSettings {
  apiKey: string;
  defaultModel: string;
  monthlyBudgetUsd: number;
}

export async function getClaudeSettings(): Promise<ClaudeSettings> {
  const env = loadConfig();
  const db = await loadSetting<Partial<ClaudeSettings>>("claude");
  return {
    apiKey: (db?.apiKey ?? env.ANTHROPIC_API_KEY ?? "").trim(),
    defaultModel: db?.defaultModel ?? env.CLAUDE_MODEL_SONNET,
    monthlyBudgetUsd: db?.monthlyBudgetUsd ?? 1000,
  };
}

export type JiraAuthMode = "basic" | "api_token" | "pat";

export interface JiraSettings {
  /**
   * - `basic`     : Jira Server / on-prem DC with username + password
   * - `api_token` : Jira Cloud with email + API token (default)
   * - `pat`       : Jira DC 8.14+ Personal Access Token (Bearer)
   */
  authMode: JiraAuthMode;
  baseUrl: string;
  /** Login identifier — email (Cloud) or username (Server/DC). Unused in `pat` mode. */
  email: string;
  /** Password / API token / PAT depending on authMode. */
  apiToken: string;
  webhookSecret: string;
}

export async function getJiraSettings(): Promise<JiraSettings> {
  const env = loadConfig();
  const db = await loadSetting<{
    authMode?: JiraAuthMode;
    baseUrl?: string;
    email?: string;
    apiToken?: string;
    webhookSecret?: string;
  }>("jira");
  return {
    authMode: (db?.authMode as JiraAuthMode) ?? "api_token",
    baseUrl: (db?.baseUrl ?? env.JIRA_BASE_URL ?? "").trim(),
    email: (db?.email ?? env.JIRA_USERNAME ?? "").trim(),
    apiToken: (db?.apiToken ?? env.JIRA_API_TOKEN ?? "").trim(),
    webhookSecret: (db?.webhookSecret ?? env.JIRA_WEBHOOK_SECRET ?? "").trim(),
  };
}

export interface GitSettings {
  platform: "bitbucket" | "github" | "gitlab" | "gitea";
  baseUrl: string;
  username: string;
  appPassword: string;
  webhookSecret: string;
  defaultProject: string;
  branchPrefix: string;
  autoPush: boolean;
}

export async function getGitSettings(): Promise<GitSettings> {
  const env = loadConfig();
  const db = await loadSetting<Partial<GitSettings>>("git");
  return {
    platform: (db?.platform as GitSettings["platform"]) ?? "bitbucket",
    baseUrl: (db?.baseUrl ?? env.BITBUCKET_BASE_URL ?? "").trim(),
    username: (db?.username ?? env.BITBUCKET_USERNAME ?? "").trim(),
    appPassword: (db?.appPassword ?? env.BITBUCKET_APP_PASSWORD ?? "").trim(),
    webhookSecret: (db?.webhookSecret ?? env.BITBUCKET_WEBHOOK_SECRET ?? "").trim(),
    defaultProject: (db?.defaultProject ?? "").trim(),
    branchPrefix: db?.branchPrefix ?? "feature/",
    autoPush: db?.autoPush ?? true,
  };
}
