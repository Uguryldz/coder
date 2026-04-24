import { db } from "@/lib/db";
import { SettingsClient } from "./settings-client";

export const dynamic = "force-dynamic";

async function loadSetting<T>(key: string, fallback: T): Promise<T> {
  const s = await db.setting.findUnique({ where: { key } });
  return (s?.value as T | undefined) ?? fallback;
}

export default async function SettingsPage() {
  const [jira, git, claude, sla, piiList] = await Promise.all([
    loadSetting("jira", {
      authMode: "api_token" as "basic" | "api_token" | "pat",
      baseUrl: "",
      email: "",
      apiToken: "",
      projects: [] as string[],
    }),
    loadSetting("git", {
      platform: "bitbucket" as "bitbucket" | "github" | "gitlab" | "gitea",
      baseUrl: "",
      username: "",
      appPassword: "",
      webhookSecret: "",
      defaultProject: "",
      branchPrefix: "feature/",
      autoPush: true,
    }),
    loadSetting("claude", {
      apiKey: "",
      defaultModel: "claude-sonnet-4-5",
      monthlyBudgetUsd: 1000,
    }),
    loadSetting("sla", {
      intakeHours: 4,
      analysisHours: 8,
      developmentHours: 24,
      reviewHours: 8,
      qaHours: 24,
    }),
    db.pIIMaskingConfig.findMany({ orderBy: { updatedAt: "desc" }, take: 1 }),
  ]);
  const pii = piiList[0] ?? null;

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Ayarlar</h1>
        <p className="text-sm text-muted-foreground">
          Jira, Git (Bitbucket/GitHub/GitLab/Gitea), Claude, PII maskesi, SLA.
        </p>
      </div>
      <SettingsClient
        initial={{
          jira,
          git,
          claude,
          sla,
          pii: pii
            ? {
                id: pii.id,
                enabled: pii.enabled,
                fieldRules: pii.fieldRules as unknown,
                patternRules: pii.patternRules as unknown,
              }
            : null,
        }}
      />
    </div>
  );
}
