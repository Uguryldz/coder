-- 0030 — Application.jiraProjectKey: bir Jira projesine birden çok depo.
--
-- Proje bağlaması (JiraProjectBinding) tek bir VARSAYILAN uygulama taşır. Bankada
-- aynı Jira projesinin altında React ön yüz, Java servis ve betik depoları var;
-- dinleme kuralının depo eşlemesi bunlar arasından seçer. Hangi deponun hangi
-- projeye ait olduğu bu kolonda. Yalnız kolon + indeks; NULL = eski kayıt.
ALTER TABLE "Application"
  ADD COLUMN IF NOT EXISTS "jiraProjectKey" VARCHAR(32);
CREATE INDEX IF NOT EXISTS "Application_jiraProjectKey_idx" ON "Application" ("jiraProjectKey");
