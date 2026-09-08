-- 0029 — ListeningRule.repoMapJson: Jira alanına göre depo eşlemesi.
--
-- Bir Jira projesi bugün TEK uygulamaya bağlanıyor (JiraProjectBinding).
-- Bankada aynı projede birden çok depo var ve hangisine gidileceğini ticket'ın
-- bir özel alanı ("İş Ailesi") söylüyor. Kural artık o alanın DEĞERİNİ bir
-- uygulamaya (ve isteğe bağlı hedef dala) eşleyen bir tablo taşıyor:
--   { "field": "customfield_10234", "fieldName": "İş Ailesi",
--     "entries": [ { "value": "Krediler", "appId": "bank/kredi", "targetBranch": "develop" } ] }
-- NULL = eskisi gibi proje bağlamasının uygulaması.
--
-- Yalnız kolon ekler; veri yok, constraint yok; IF NOT EXISTS ile yeniden
-- uygulanabilir (0024 ile aynı kalıp).
ALTER TABLE "ListeningRule"
  ADD COLUMN IF NOT EXISTS "repoMapJson" JSONB;
