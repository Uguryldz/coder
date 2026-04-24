# Entegrasyonlar

## Jira DC / Server

### Bağlantı
`.env`:
```
JIRA_BASE_URL="https://jira.company.local"
JIRA_USERNAME="orkestra-bot"
JIRA_API_TOKEN="xxx"          # Kullanıcının kişisel token'ı
JIRA_WEBHOOK_SECRET="..."
```

### Webhook
Admin → System → Webhooks → Create:
- URL: `https://<orkestra>/webhooks/jira`
- Secret: `JIRA_WEBHOOK_SECRET`
- Events: `Issue Created`, `Comment Created`, `Comment Updated`
- (Opsiyonel) JQL: `project in (PROJ1, PROJ2)`

### Custom Fields
Agent Studio → Settings → Jira field mapping:
- `po_approver` (User)
- `tech_lead` (User)
- `qa_lead` (User)
- `backup_*` (User, delegation)
- `ai_workflow_detail` (URL field — her ticket'a otomatik yazılır)

### Status Mapping
Agent Studio'dan step → status mapping customize edilebilir. Default Türkçe:
- `AI Analyzing` / `Waiting for PO` / `Waiting for Tech Lead` / ...

## Bitbucket DC

### Bağlantı
```
BITBUCKET_BASE_URL="https://bb.company.local"
BITBUCKET_USERNAME="orkestra-bot"
BITBUCKET_APP_PASSWORD="xxx"
BITBUCKET_WEBHOOK_SECRET="..."
```

### Webhook (her repo için)
Repository settings → Webhooks:
- URL: `https://<orkestra>/webhooks/bitbucket`
- Secret: `BITBUCKET_WEBHOOK_SECRET`
- Events: Pull request — Opened/Comment/Approved/Declined/Merged, Pipelines — Completed

### Branch Protection
API otomatik set eder (`setBranchRestriction`): `feature/*` pattern için no force-push + fast-forward-only.

### Pipelines (CI Gate 10b)
Her repo'da `bitbucket-pipelines.yml` normal şekilde tanımlı. Orkestra webhook'la sonucu bekler.

### `.orkestra.yaml`
Her repo kökünde:
```yaml
language: node
sandbox_image: node:20-alpine
commands:
  install: "npm ci"
  lint: "npm run lint"
  build: "npm run build"
  test_unit: "npm test"
  test_integration: "npm run test:int"
  coverage: "npm run coverage"
test_dependencies: [postgres:16, redis:7]
cache_paths: [node_modules, ~/.npm]
coverage_threshold: 70
```

## Claude API

```
ANTHROPIC_API_KEY="sk-ant-..."
LLM_MODE="real"   # mock ya da real
CLAUDE_MODEL_OPUS="claude-opus-4-7"
CLAUDE_MODEL_SONNET="claude-sonnet-4-6"
CLAUDE_MODEL_HAIKU="claude-haiku-4-5-20251001"
```

Prompt caching otomatik. Rate limit:
```
ANTHROPIC_RPM_LIMIT="4000"
ANTHROPIC_TPM_INPUT_LIMIT="2000000"
```

## Slack (Opsiyonel)

```
SLACK_WEBHOOK_URL="https://hooks.slack.com/services/XXX/YYY/ZZZ"
```

Kritik olaylar:
- Bütçe aşımı
- Workflow fail
- 3. ret eskalasyon
- SLA timeout

## TestRail (Opsiyonel)

```
TESTRAIL_BASE_URL="https://testrail.company.local"
TESTRAIL_USER="orkestra"
TESTRAIL_API_KEY="xxx"
```

`test-designer` çıktısı otomatik TestRail'e push olur (proje adı = Jira project key).

## Vault

Docker Compose içinde gömülü geliyor. Prod'da müşteri kendi Vault'unu kullanmak isterse:

```
VAULT_ADDR="https://vault.company.local"
VAULT_TOKEN="..."
VAULT_MOUNT="orkestra"
```

Secret yolları:
- `secret/orkestra/jira-token`
- `secret/orkestra/bitbucket-token`
- `secret/orkestra/claude-key`
- `secret/orkestra/db-creds`
