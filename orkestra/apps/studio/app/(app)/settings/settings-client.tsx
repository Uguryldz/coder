"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { AlertTriangle, CheckCircle2, ExternalLink, KeyRound, RefreshCw, Save } from "lucide-react";
import * as React from "react";

type JiraAuthMode = "basic" | "api_token" | "pat";
type JiraCfg = {
  authMode: JiraAuthMode;
  baseUrl: string;
  email: string;
  apiToken: string;
  projects: string[];
};

type GitPlatform = "bitbucket" | "github" | "gitlab" | "gitea";
type GitCfg = {
  platform: GitPlatform;
  baseUrl: string;
  username: string;
  appPassword: string;
  webhookSecret: string;
  defaultProject: string;
  branchPrefix: string;
  autoPush: boolean;
};

type ClaudeCfg = {
  apiKey: string;
  defaultModel: string;
  monthlyBudgetUsd: number;
};

type SlaCfg = {
  intakeHours: number;
  analysisHours: number;
  developmentHours: number;
  reviewHours: number;
  qaHours: number;
};

type PiiCfg = {
  id: string;
  enabled: boolean;
  fieldRules: unknown;
  patternRules: unknown;
} | null;

export function SettingsClient({
  initial,
}: {
  initial: {
    jira: JiraCfg;
    git: GitCfg;
    claude: ClaudeCfg;
    sla: SlaCfg;
    pii: PiiCfg;
  };
}) {
  const { push } = useToast();
  const [jira, setJira] = React.useState<JiraCfg>(initial.jira);
  const [git, setGit] = React.useState<GitCfg>(initial.git);
  const [claude, setClaude] = React.useState<ClaudeCfg>(initial.claude);
  const [sla, setSla] = React.useState<SlaCfg>(initial.sla);
  const [piiEnabled, setPiiEnabled] = React.useState(initial.pii?.enabled ?? true);
  const [fieldRulesText, setFieldRulesText] = React.useState(
    JSON.stringify(initial.pii?.fieldRules ?? [], null, 2),
  );
  const [patternRulesText, setPatternRulesText] = React.useState(
    JSON.stringify(initial.pii?.patternRules ?? [], null, 2),
  );
  const [saving, setSaving] = React.useState<string | null>(null);

  async function saveSetting(key: string, value: unknown) {
    setSaving(key);
    try {
      const res = await fetch(`/api/resources/settings/${key}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value }),
      });
      if (!res.ok) {
        // Fallback: create if missing.
        const createRes = await fetch("/api/resources/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key, value }),
        });
        if (!createRes.ok) throw new Error("Kaydedilemedi");
      }
      push({ title: "Kaydedildi", variant: "success" });
    } catch (err) {
      push({
        title: "Hata",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setSaving(null);
    }
  }

  async function savePii() {
    setSaving("pii");
    try {
      let fieldRules: unknown = [];
      let patternRules: unknown = [];
      try {
        fieldRules = JSON.parse(fieldRulesText || "[]");
        patternRules = JSON.parse(patternRulesText || "[]");
      } catch {
        throw new Error("JSON geçersiz");
      }
      const body = { enabled: piiEnabled, fieldRules, patternRules };
      const res = initial.pii
        ? await fetch(`/api/resources/pii-configs/${initial.pii.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          })
        : await fetch("/api/resources/pii-configs", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
      if (!res.ok) throw new Error("Kaydedilemedi");
      push({ title: "PII yapılandırması kaydedildi", variant: "success" });
    } catch (err) {
      push({
        title: "Hata",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <JiraCard
        jira={jira}
        setJira={setJira}
        saving={saving === "jira"}
        onSave={() => saveSetting("jira", jira)}
        toast={push}
      />

      <GitCard
        git={git}
        setGit={setGit}
        saving={saving === "git"}
        onSave={() => saveSetting("git", git)}
        toast={push}
      />

      <ClaudeCard
        claude={claude}
        setClaude={setClaude}
        saving={saving === "claude"}
        onSave={() => saveSetting("claude", claude)}
        toast={push}
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">SLA Varsayılanları (saat)</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 md:grid-cols-5">
          {(Object.keys(sla) as (keyof SlaCfg)[]).map((k) => (
            <Field key={k} label={k.replace("Hours", "")}>
              <Input
                type="number"
                value={sla[k]}
                onChange={(e) => setSla({ ...sla, [k]: Number(e.target.value) })}
              />
            </Field>
          ))}
        </CardContent>
        <SaveRow busy={saving === "sla"} onSave={() => saveSetting("sla", sla)} />
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">PII Maskeleme</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={piiEnabled}
              onChange={(e) => setPiiEnabled(e.target.checked)}
            />
            Maskeleme etkin
          </label>
          <Field label="Alan kuralları (JSON dizi)">
            <Textarea
              rows={5}
              value={fieldRulesText}
              onChange={(e) => setFieldRulesText(e.target.value)}
              className="font-mono text-xs"
              placeholder='[{"field":"description","strategy":"hash"}]'
            />
          </Field>
          <Field label="Regex kuralları (JSON dizi)">
            <Textarea
              rows={5}
              value={patternRulesText}
              onChange={(e) => setPatternRulesText(e.target.value)}
              className="font-mono text-xs"
              placeholder='[{"name":"email","regex":"[\\w.+-]+@[\\w-]+","replacement":"[EMAIL]"}]'
            />
          </Field>
        </CardContent>
        <SaveRow busy={saving === "pii"} onSave={savePii} />
      </Card>
    </div>
  );
}

function Field({
  label,
  children,
  className = "",
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function SaveRow({ busy, onSave }: { busy: boolean; onSave: () => void }) {
  return (
    <div className="flex justify-end border-t border-border px-4 py-3">
      <Button size="sm" onClick={onSave} disabled={busy}>
        <Save className="h-3.5 w-3.5" />
        {busy ? "Kaydediliyor..." : "Kaydet"}
      </Button>
    </div>
  );
}

const JIRA_AUTH_LABELS: Record<JiraAuthMode, string> = {
  api_token: "Jira Cloud — E-posta + API Token",
  basic: "Jira Server / DC — Kullanıcı adı + Şifre (Basic)",
  pat: "Jira DC 8.14+ — Personal Access Token (Bearer)",
};

function JiraCard(props: {
  jira: JiraCfg;
  setJira: (j: JiraCfg) => void;
  saving: boolean;
  onSave: () => void;
  toast: ReturnType<typeof useToast>["push"];
}) {
  const { jira, setJira, saving, onSave, toast } = props;
  const [testing, setTesting] = React.useState(false);
  const [tested, setTested] = React.useState<"ok" | "fail" | null>(null);
  const [errorMsg, setErrorMsg] = React.useState("");
  const [user, setUser] = React.useState<{ displayName: string; email?: string } | null>(null);

  const mode = jira.authMode ?? "api_token";
  const needsUsername = mode !== "pat";

  const usernameLabel =
    mode === "api_token" ? "E-posta (Atlassian hesabı)" : "Kullanıcı Adı (Jira login)";
  const secretLabel =
    mode === "basic" ? "Şifre" : mode === "pat" ? "Personal Access Token" : "API Token";
  const secretPlaceholder =
    mode === "basic"
      ? "Kullanıcının Jira şifresi"
      : mode === "pat"
        ? "NjcxMj...=="
        : "ATATT3xFf...";

  function update<K extends keyof JiraCfg>(k: K, v: JiraCfg[K]) {
    setJira({ ...jira, [k]: v });
  }

  async function testConnection() {
    if (!jira.baseUrl || !jira.apiToken || (needsUsername && !jira.email)) {
      toast({ title: "Gerekli alanları doldur", variant: "destructive" });
      return;
    }
    setTesting(true);
    setTested(null);
    setErrorMsg("");
    setUser(null);
    try {
      const res = await fetch("/api/jira/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          authMode: mode,
          baseUrl: jira.baseUrl,
          username: jira.email,
          apiToken: jira.apiToken,
        }),
      });
      const data = await res.json();
      if (!data.ok) {
        setTested("fail");
        setErrorMsg([data.error, data.hint, data.body].filter(Boolean).join(" · "));
        toast({ title: "Bağlantı başarısız", description: data.error, variant: "destructive" });
        return;
      }
      setTested("ok");
      setUser(data.user);
      toast({
        title: "Bağlantı tamam",
        description: `Giriş: ${data.user?.displayName ?? "(unknown)"}`,
      });
    } catch (e) {
      setTested("fail");
      setErrorMsg((e as Error).message);
    } finally {
      setTesting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Jira Yapılandırması</CardTitle>
        <p className="mt-1 text-xs text-muted-foreground">
          Orkestra, Jira'dan ticket'ları okur, yorum yazar, durum geçişleri yapar.
        </p>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field label="Auth Modu" className="md:col-span-2">
          <Select value={mode} onValueChange={(v) => update("authMode", v as JiraAuthMode)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(JIRA_AUTH_LABELS) as JiraAuthMode[]).map((m) => (
                <SelectItem key={m} value={m}>
                  {JIRA_AUTH_LABELS[m]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="mt-1 text-[10px] text-muted-foreground">
            {mode === "api_token" && (
              <>
                Cloud için tek seçenek. Token üretimi:{" "}
                <a
                  className="underline"
                  href="https://id.atlassian.com/manage-profile/security/api-tokens"
                  target="_blank"
                  rel="noreferrer"
                >
                  id.atlassian.com → API tokens
                </a>
              </>
            )}
            {mode === "basic" && (
              <>
                Sadece Jira <b>Server / on-prem DC</b>. Jira Cloud basic auth'u Haziran 2024'te
                kapattı — Cloud ise API Token moduna geç.
              </>
            )}
            {mode === "pat" && (
              <>
                Jira DC <b>8.14+</b>. Üretim: kullanıcı profili → Personal Access Tokens.
              </>
            )}
          </p>
        </Field>

        <Field label="Base URL" className="md:col-span-2">
          <Input
            value={jira.baseUrl}
            onChange={(e) => update("baseUrl", e.target.value.trim())}
            placeholder={
              mode === "api_token"
                ? "https://sirket.atlassian.net"
                : "https://jira.sirket.com"
            }
          />
        </Field>

        {needsUsername && (
          <Field label={usernameLabel}>
            <Input
              value={jira.email}
              onChange={(e) => update("email", e.target.value.trim())}
              type={mode === "api_token" ? "email" : "text"}
              placeholder={mode === "api_token" ? "adin@sirket.com" : "orkestra.bot"}
            />
          </Field>
        )}

        <Field label={secretLabel} className={needsUsername ? "" : "md:col-span-2"}>
          <Input
            value={jira.apiToken}
            onChange={(e) => update("apiToken", e.target.value.trim())}
            type="password"
            placeholder={secretPlaceholder}
            className="font-mono text-xs"
          />
        </Field>

        <Field label="Projeler (virgülle ayrılmış)" className="md:col-span-2">
          <Input
            value={jira.projects.join(", ")}
            onChange={(e) =>
              setJira({
                ...jira,
                projects: e.target.value
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
            placeholder="PROJ1, PROJ2"
          />
        </Field>

        <div className="flex flex-col gap-2 border-t border-border pt-3 md:col-span-2">
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={testConnection}
              disabled={testing || !jira.baseUrl || !jira.apiToken || (needsUsername && !jira.email)}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${testing ? "animate-spin" : ""}`} />
              {testing ? "Bağlanıyor..." : "Bağlantıyı Test Et"}
            </Button>
            {tested === "ok" && (
              <span className="inline-flex items-center gap-1 rounded bg-green-500/10 px-1.5 py-0.5 text-xs text-green-700">
                <CheckCircle2 className="h-3 w-3" /> {user?.displayName} giriş yaptı
              </span>
            )}
            {tested === "fail" && (
              <span className="inline-flex items-center gap-1 rounded bg-red-500/10 px-1.5 py-0.5 text-xs text-red-700">
                <AlertTriangle className="h-3 w-3" /> Başarısız
              </span>
            )}
          </div>
          {errorMsg && (
            <p className="rounded bg-red-500/5 p-1.5 font-mono text-[10px] text-red-700">
              {errorMsg}
            </p>
          )}
        </div>
      </CardContent>
      <SaveRow busy={saving} onSave={onSave} />
    </Card>
  );
}

interface Model {
  id: string;
  displayName: string;
  createdAt?: string;
}

function ClaudeCard(props: {
  claude: ClaudeCfg;
  setClaude: (c: ClaudeCfg) => void;
  saving: boolean;
  onSave: () => void;
  toast: ReturnType<typeof useToast>["push"];
}) {
  const { claude, setClaude, saving, onSave, toast } = props;
  const [models, setModels] = React.useState<Model[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [tested, setTested] = React.useState<"ok" | "fail" | null>(null);
  const [errorMsg, setErrorMsg] = React.useState<string>("");

  // Token format tespit
  const key = (claude.apiKey ?? "").trim();
  const keyType: "api" | "oauth" | "empty" | "unknown" =
    key.length === 0
      ? "empty"
      : key.startsWith("sk-ant-api")
        ? "api"
        : key.startsWith("sk-ant-oat")
          ? "oauth"
          : "unknown";

  function setTrimmedKey(v: string) {
    setClaude({ ...claude, apiKey: v.trim() });
  }

  async function fetchModels() {
    if (!key) {
      toast({ title: "Token gir", variant: "destructive" });
      return;
    }
    if (keyType !== "api" && keyType !== "oauth") {
      setTested("fail");
      setErrorMsg("Token formatı tanınmadı. Beklenen: sk-ant-api... veya sk-ant-oat...");
      return;
    }
    setLoading(true);
    setTested(null);
    setErrorMsg("");
    try {
      const res = await fetch(`/api/claude/models?apiKey=${encodeURIComponent(key)}`);
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { models: Model[] };
      setModels(data.models);
      setTested("ok");
      toast({
        title: "Bağlantı başarılı",
        description: `${data.models.length} model bulundu`,
      });
      if (!data.models.some((m) => m.id === claude.defaultModel) && data.models[0]) {
        setClaude({ ...claude, apiKey: key, defaultModel: data.models[0].id });
      } else if (claude.apiKey !== key) {
        setClaude({ ...claude, apiKey: key });
      }
    } catch (e) {
      setTested("fail");
      setErrorMsg((e as Error).message);
      toast({
        title: "Modeller alınamadı",
        description: (e as Error).message,
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }

  // Sayfa açılınca token varsa otomatik dene (API veya OAuth)
  React.useEffect(() => {
    if ((keyType === "api" || keyType === "oauth") && models.length === 0) {
      void fetchModels();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Claude Yapılandırması</CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field label="Token (API key veya OAuth)" className="md:col-span-2">
          <div className="flex items-center gap-2">
            <Input
              value={claude.apiKey}
              onChange={(e) => setTrimmedKey(e.target.value)}
              onBlur={(e) => setTrimmedKey(e.target.value)}
              type="password"
              placeholder="sk-ant-api03-... veya sk-ant-oat01-..."
              className="flex-1 font-mono text-xs"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={fetchModels}
              disabled={loading || !key}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
              {loading ? "Alınıyor..." : "Doğrula + Modelleri Getir"}
            </Button>
          </div>

          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
            {keyType === "api" && (
              <span className="inline-flex items-center gap-1 rounded bg-blue-500/10 px-1.5 py-0.5 text-blue-600">
                <KeyRound className="h-3 w-3" /> API Key
              </span>
            )}
            {keyType === "oauth" && (
              <span className="inline-flex items-center gap-1 rounded bg-purple-500/10 px-1.5 py-0.5 text-purple-600">
                <KeyRound className="h-3 w-3" /> OAuth Token (Claude Code)
              </span>
            )}
            {keyType === "unknown" && key.length > 0 && (
              <span className="inline-flex items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-amber-700">
                <AlertTriangle className="h-3 w-3" /> Format tanınmadı (sk-ant-api... veya sk-ant-oat... bekleniyor)
              </span>
            )}
            {tested === "ok" && (
              <span className="inline-flex items-center gap-1 rounded bg-green-500/10 px-1.5 py-0.5 text-green-700">
                <CheckCircle2 className="h-3 w-3" /> Bağlantı tamam · {models.length} model
              </span>
            )}
            {tested === "fail" && (
              <span className="inline-flex items-center gap-1 rounded bg-red-500/10 px-1.5 py-0.5 text-red-700">
                <AlertTriangle className="h-3 w-3" /> Başarısız
              </span>
            )}
          </div>
          {tested === "fail" && errorMsg && (
            <p className="mt-1 rounded bg-red-500/5 p-1.5 font-mono text-[10px] text-red-700">
              {errorMsg}
            </p>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-2 text-xs text-muted-foreground">
            <span className="font-medium">Token nereden:</span>
            <a
              href="https://console.anthropic.com/settings/keys"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded border border-border px-2 py-0.5 hover:bg-secondary"
            >
              <ExternalLink className="h-3 w-3" /> Anthropic Console (API Key)
            </a>
            <span>ya da</span>
            <code className="rounded bg-secondary px-1 py-0.5">claude setup-token</code>
            <span>(OAuth)</span>
          </div>
        </Field>

        <Field label="Varsayılan Model" className="md:col-span-2">
          {models.length > 0 ? (
            <Select
              value={claude.defaultModel}
              onValueChange={(v) => setClaude({ ...claude, defaultModel: v })}
            >
              <SelectTrigger>
                <SelectValue placeholder="Model seç" />
              </SelectTrigger>
              <SelectContent>
                {models.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    <div className="flex flex-col">
                      <span className="text-sm">{m.displayName}</span>
                      <span className="text-[10px] text-muted-foreground">{m.id}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Input
              value={claude.defaultModel}
              onChange={(e) => setClaude({ ...claude, defaultModel: e.target.value })}
              placeholder="claude-sonnet-4-6 · API key girip 'Modelleri Getir'"
            />
          )}
          {models.length > 0 && (
            <p className="mt-1 text-xs text-muted-foreground">
              {models.length} model listelendi (Opus → Sonnet → Haiku sıralı)
            </p>
          )}
        </Field>

        <Field label="Aylık Bütçe (USD)">
          <Input
            type="number"
            value={claude.monthlyBudgetUsd}
            onChange={(e) =>
              setClaude({
                ...claude,
                monthlyBudgetUsd: Number(e.target.value),
              })
            }
          />
        </Field>
      </CardContent>
      <SaveRow busy={saving} onSave={onSave} />
    </Card>
  );
}

function GitCard(props: {
  git: GitCfg;
  setGit: (g: GitCfg) => void;
  saving: boolean;
  onSave: () => void;
  toast: ReturnType<typeof useToast>["push"];
}) {
  const { git, setGit, saving, onSave, toast } = props;
  const [testing, setTesting] = React.useState(false);
  const [tested, setTested] = React.useState<"ok" | "fail" | null>(null);
  const [errorMsg, setErrorMsg] = React.useState<string>("");
  const [repos, setRepos] = React.useState<Array<{ name: string; slug: string; project: string }>>([]);
  const [showAdvanced, setShowAdvanced] = React.useState(false);

  const PLATFORM_LABELS: Record<GitPlatform, string> = {
    bitbucket: "Bitbucket Data Center / Cloud",
    github: "GitHub (v1.1 — stub)",
    gitlab: "GitLab (v1.1 — stub)",
    gitea: "Gitea (Bitbucket-uyumlu)",
  };

  function update<K extends keyof GitCfg>(k: K, v: GitCfg[K]) {
    setGit({ ...git, [k]: v });
  }

  async function testConnection() {
    if (!git.baseUrl || !git.username || !git.appPassword) {
      toast({ title: "Tüm alanları doldur", variant: "destructive" });
      return;
    }
    setTesting(true);
    setTested(null);
    setErrorMsg("");
    try {
      const res = await fetch("/api/git/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          platform: git.platform,
          baseUrl: git.baseUrl,
          username: git.username,
          appPassword: git.appPassword,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      setTested("ok");
      setRepos(data.repos ?? []);
      toast({
        title: "Bağlantı başarılı",
        description: `${data.repos?.length ?? 0} repo erişilebilir`,
      });
    } catch (e) {
      setTested("fail");
      setErrorMsg((e as Error).message);
      toast({ title: "Bağlantı başarısız", description: (e as Error).message, variant: "destructive" });
    } finally {
      setTesting(false);
    }
  }

  const webhookUrl =
    typeof window !== "undefined"
      ? `${window.location.origin.replace(/:\d+$/, ":7001")}/webhooks/bitbucket`
      : "http://<host>:7001/webhooks/bitbucket";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Git Bağlantısı (push + clone)</CardTitle>
        <p className="mt-1 text-xs text-muted-foreground">
          Orkestra bu bilgilerle repo'nu <b>clone</b>lar, AI patch'ini uygular, <b>test eder</b>, onay sonrası{" "}
          <b>push</b> eder ve <b>PR açar</b>.
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {/* ——— TEMEL BAĞLANTI ——— */}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label="Platform">
            <Select value={git.platform} onValueChange={(v) => update("platform", v as GitPlatform)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(PLATFORM_LABELS) as GitPlatform[]).map((p) => (
                  <SelectItem key={p} value={p}>
                    {PLATFORM_LABELS[p]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field label="Sunucu URL'i">
            <Input
              value={git.baseUrl}
              onChange={(e) => update("baseUrl", e.target.value.trim())}
              placeholder="https://bitbucket.sirket.com"
            />
          </Field>

          <Field label="Bot Kullanıcı Adı">
            <Input
              value={git.username}
              onChange={(e) => update("username", e.target.value.trim())}
              placeholder="orkestra-bot"
            />
            <p className="mt-1 text-[10px] text-muted-foreground">
              Git'te oluşturulan servis hesabı. Repolara commit/push yapacak kullanıcı.
            </p>
          </Field>

          <Field label="Erişim Token'ı">
            <Input
              type="password"
              value={git.appPassword}
              onChange={(e) => update("appPassword", e.target.value.trim())}
              placeholder="App password veya Personal Access Token"
              className="font-mono text-xs"
            />
            <p className="mt-1 text-[10px] text-muted-foreground">
              Bu kullanıcıya atanmış token. Repo:read + repo:write yetkileri yeterli.
            </p>
          </Field>
        </div>

        {/* ——— BAĞLANTIYI DOĞRULA ——— */}
        <div className="flex flex-col gap-2 border-t border-border pt-3">
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={testConnection}
              disabled={testing || !git.baseUrl || !git.username || !git.appPassword}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${testing ? "animate-spin" : ""}`} />
              {testing ? "Bağlanıyor..." : "Bağlantıyı Test Et ve Repoları Göster"}
            </Button>
            {tested === "ok" && (
              <span className="inline-flex items-center gap-1 rounded bg-green-500/10 px-1.5 py-0.5 text-xs text-green-700">
                <CheckCircle2 className="h-3 w-3" /> Bağlantı tamam · {repos.length} repo
              </span>
            )}
            {tested === "fail" && (
              <span className="inline-flex items-center gap-1 rounded bg-red-500/10 px-1.5 py-0.5 text-xs text-red-700">
                <AlertTriangle className="h-3 w-3" /> Başarısız
              </span>
            )}
          </div>
          {errorMsg && (
            <p className="rounded bg-red-500/5 p-1.5 font-mono text-[10px] text-red-700">
              {errorMsg}
            </p>
          )}
        </div>

        {/* ——— REPO GEZGİNİ ——— */}
        {repos.length > 0 && <ReposBrowser repos={repos} />}

        {/* ——— GELİŞMİŞ ——— */}
        <div className="border-t border-border pt-3">
          <button
            type="button"
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setShowAdvanced((v) => !v)}
          >
            {showAdvanced ? "▾" : "▸"} Gelişmiş ayarlar
          </button>
          {showAdvanced && (
            <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
              <Field label="Branch ön-eki (AI branch adı)">
                <Input
                  value={git.branchPrefix}
                  onChange={(e) => update("branchPrefix", e.target.value)}
                  placeholder="feature/"
                />
                <p className="mt-1 text-[10px] text-muted-foreground">
                  AI'ın oluşturacağı branch'ler: <code>{git.branchPrefix}JIRA-123</code>
                </p>
              </Field>

              <Field label="Varsayılan Proje (opsiyonel)">
                <Input
                  value={git.defaultProject}
                  onChange={(e) => update("defaultProject", e.target.value.trim())}
                  placeholder="(Jira project key eşleşmezse kullanılır)"
                />
              </Field>

              <Field label="Otomatik Push" className="md:col-span-2">
                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={git.autoPush}
                    onChange={(e) => update("autoPush", e.target.checked)}
                    className="h-4 w-4"
                  />
                  Onaylanan kod otomatik push edilsin, PR açılsın
                </label>
                <p className="mt-1 text-[10px] text-muted-foreground">
                  Kapalıysa: AI patch sandbox'ta test edilir, push manuel yapılır.
                </p>
              </Field>

              <Field label="Webhook URL'i (Git repolarına yapıştır)" className="md:col-span-2">
                <div className="flex items-center gap-2">
                  <Input value={webhookUrl} readOnly className="font-mono text-xs" />
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      navigator.clipboard.writeText(webhookUrl);
                      toast({ title: "Kopyalandı" });
                    }}
                  >
                    Kopyala
                  </Button>
                </div>
                <p className="mt-1 text-[10px] text-muted-foreground">
                  Her repo'nun webhooks sayfasına bu URL'i ekle. Events:{" "}
                  <code>pr:opened</code>, <code>pr:approved</code>, <code>pr:merged</code>,{" "}
                  <code>pr:comment:added</code>, <code>repo:push</code>.
                </p>
              </Field>

              <Field label="Webhook Secret">
                <Input
                  type="password"
                  value={git.webhookSecret}
                  onChange={(e) => update("webhookSecret", e.target.value.trim())}
                  placeholder="HMAC imza secret'ı"
                  className="font-mono text-xs"
                />
                <p className="mt-1 text-[10px] text-muted-foreground">
                  Webhook payload'ı doğrulamak için (sahte webhook'ları reddeder).
                </p>
              </Field>
            </div>
          )}
        </div>
      </CardContent>
      <SaveRow busy={saving} onSave={onSave} />
    </Card>
  );
}

function ReposBrowser({
  repos,
}: {
  repos: Array<{ name: string; slug: string; project: string }>;
}) {
  const [filter, setFilter] = React.useState("");
  const [selected, setSelected] = React.useState<string | null>(null);

  const byProject = React.useMemo(() => {
    const m = new Map<string, typeof repos>();
    for (const r of repos) {
      if (!m.has(r.project)) m.set(r.project, []);
      m.get(r.project)!.push(r);
    }
    return m;
  }, [repos]);

  const filtered = React.useMemo(() => {
    if (!filter.trim()) return byProject;
    const q = filter.toLowerCase();
    const m = new Map<string, typeof repos>();
    for (const [p, list] of byProject) {
      const matched = list.filter(
        (r) => r.name.toLowerCase().includes(q) || r.slug.toLowerCase().includes(q) || p.toLowerCase().includes(q),
      );
      if (matched.length > 0) m.set(p, matched);
    }
    return m;
  }, [byProject, filter]);

  return (
    <div className="rounded-md border border-border bg-secondary/20">
      <div className="flex items-center gap-2 border-b border-border bg-secondary/40 px-3 py-2">
        <span className="text-sm font-medium">📦 Repolar ({repos.length})</span>
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Ara: proje veya repo adı..."
          className="h-7 max-w-xs text-xs"
        />
      </div>
      <div className="max-h-80 overflow-auto">
        {Array.from(filtered.entries()).map(([project, list]) => (
          <div key={project} className="border-b border-border last:border-0">
            <div className="bg-secondary/30 px-3 py-1.5 text-xs font-semibold">
              🏢 {project} <span className="text-muted-foreground">({list.length})</span>
            </div>
            <ul className="divide-y divide-border/50">
              {list.map((r) => {
                const key = `${r.project}/${r.slug}`;
                const isSel = selected === key;
                return (
                  <li key={key}>
                    <button
                      type="button"
                      onClick={() => setSelected(isSel ? null : key)}
                      className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-xs hover:bg-secondary/40 ${
                        isSel ? "bg-secondary/60" : ""
                      }`}
                    >
                      <div className="flex min-w-0 flex-col">
                        <span className="font-medium">📁 {r.name || r.slug}</span>
                        <code className="text-[10px] text-muted-foreground">
                          {r.project}/{r.slug}
                        </code>
                      </div>
                      <span className="text-muted-foreground">{isSel ? "▾" : "▸"}</span>
                    </button>
                    {isSel && (
                      <div className="bg-background/60 px-3 py-2 text-[10px] text-muted-foreground">
                        <div>
                          Clone URL:{" "}
                          <code className="break-all">git@.../{r.project}/{r.slug}.git</code>
                        </div>
                        <div className="mt-1">
                          Bu repo'yu bir Jira project/component'ına bağlamak için{" "}
                          <code>.orkestra.yaml</code> ekle (repo kökünde).
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
        {filtered.size === 0 && (
          <p className="px-3 py-4 text-center text-xs text-muted-foreground">
            Filtreye uyan repo yok
          </p>
        )}
      </div>
    </div>
  );
}
