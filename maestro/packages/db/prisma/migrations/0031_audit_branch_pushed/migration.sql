-- 0031 — AuditActionE.BRANCH_PUSHED: geliştirme turunun dalı yayımlandı.
--
-- 6a'nın klonda bıraktığı değişiklik artık commit'lenip gerçek uzağa itiliyor
-- (publishBranch etkinliği); PR bir dalın ÜZERİNE açılıyor. Bu, denetim
-- zincirinde kendi eylemiyle görünmeli: hangi dal, hangi sha, kaç dosya ve
-- hangi kimlikle (kısa ömürlü M31 jetonu mu, bağlantı jetonu mu).
-- `ALTER TYPE ... ADD VALUE` tabloyu yeniden yazmaz, mevcut satırlara dokunmaz.
ALTER TYPE "AuditActionE" ADD VALUE IF NOT EXISTS 'BRANCH_PUSHED';
