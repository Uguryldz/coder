export const AGENT_ROLES = [
  "intake",
  "analyst",
  "developer",
  "dev_reviewer",
  "test_designer",
  "test_reviewer",
  "test_runner",
] as const;

export type AgentRole = (typeof AGENT_ROLES)[number];

export const ROLE_LABELS: Record<AgentRole, string> = {
  intake: "Karşılama Ajanı",
  analyst: "Analist",
  developer: "Geliştirici",
  dev_reviewer: "Kod İncelemeci",
  test_designer: "Test Tasarımcı",
  test_reviewer: "Test İncelemeci",
  test_runner: "Test Koşucu",
};

export const ROLE_DESCRIPTIONS: Record<AgentRole, string> = {
  intake: "Jira bileti eksik alan taraması ve iş modu önerisi.",
  analyst: "Analiz dokümanı, teknik tasarım ve kabul kriterleri.",
  developer: "Kod yaması üretimi, PR açıklaması.",
  dev_reviewer: "Kod incelemesi, güvenlik ve breaking-change kontrolü.",
  test_designer: "Test senaryoları ve kod üretimi.",
  test_reviewer: "Test kapsam incelemesi ve eksik senaryolar.",
  test_runner: "Sandbox’ta testleri koşturma ve kapsam raporu.",
};

export const AVAILABLE_MODELS = [
  "claude-opus-4-7",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
  "gpt-4o",
  "gpt-4o-mini",
] as const;

export const KNOWLEDGE_CATEGORIES = [
  "rules",
  "conventions",
  "domain",
  "examples",
  "glossary",
] as const;

export const KNOWLEDGE_CATEGORY_LABELS: Record<(typeof KNOWLEDGE_CATEGORIES)[number], string> = {
  rules: "Kurallar",
  conventions: "Konvansiyonlar",
  domain: "Alan Bilgisi",
  examples: "Örnekler",
  glossary: "Sözlük",
};

export const WORKFLOW_STATUS_LABELS: Record<string, string> = {
  running: "Çalışıyor",
  waiting_info: "Bilgi Bekliyor",
  waiting_po: "PO Onayı",
  waiting_tech_lead: "TL Onayı",
  in_development: "Geliştirmede",
  ai_coding: "AI Kodluyor",
  security_scan: "Güvenlik Taraması",
  ai_reviewing: "AI İnceliyor",
  test_design: "Test Tasarımı",
  waiting_qa: "QA Bekliyor",
  testing: "Test Ediliyor",
  ci_running: "CI Çalışıyor",
  waiting_qa_results: "QA Sonuç Bekleniyor",
  waiting_pr_approval: "PR Onayı",
  done: "Tamamlandı",
  cancelled: "İptal",
  blocked: "Bloke",
  failed: "Hatalı",
};

export const WORK_MODE_LABELS: Record<string, string> = {
  full_auto: "Tam Otomatik",
  ai_assist: "AI Destek",
  human_lead: "İnsan Öncü",
  human_only: "Yalnız İnsan",
};
