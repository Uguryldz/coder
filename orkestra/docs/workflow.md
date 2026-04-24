# 15 Adımlık Workflow

![Workflow](../plan/diagrams/workflow.png)

## Adımlar

| # | Ad | Aktör | Açıklama |
|---|----|-------|----------|
| 0 | Work Mode | routing | Jira label/component → variant + work mode |
| 1 | Talep | — | Jira webhook: ticket oluşturuldu |
| 2 | Intake | AI | Ticket tam mı? Eksikse sorular. |
| 2b | Clarification | ⏳ reporter | Yorum bekleniyor (SLA 72h) |
| 3 | Analiz | AI | `analysisDoc` + `technicalDesign` |
| 4 | Analiz Onayı | 👤 PO | `/approve` → 5'e, `/reject` → 3'e |
| 5 | Development Onayı | 👤 Tech Lead | Teknik tasarım onayı |
| 6a | Geliştirme | AI/👤 | Work mode'a göre kod üretimi |
| 6b | Güvenlik Taraması | 🤖 | gitleaks + semgrep + trivy |
| 6c | Dev Kontrol | AI | Patch review |
| 7 | Test Senaryosu | AI | Gherkin + kod |
| 8 | Senaryo 4-Göz | AI | Coverage + pyramid kontrolü |
| 9 | Test Onayı | 👤 QA | Senaryolar yeterli mi |
| 10 | Test Koşumu | AI | Sandbox'ta çalıştırma + flaky detect |
| 10b | CI Gate | 🤖 | Bitbucket Pipelines yeşil mi |
| 11 | Test Sonuç Onayı | 👤 QA | Test raporu onayı |
| 12 | PR Onayı | 👤 Tech Lead | 4-göz + merge hazır |
| 12b | PR Yorum Döngüsü | 👤 | "Request changes" → 6a'ya geri |

## 4 Work Mode

| Mod | Analiz | Kod | Review | Test Tasarımı | Test Koşumu |
|-----|--------|-----|--------|---------------|-------------|
| full-auto | AI | AI | AI | AI | AI |
| ai-assist | AI | 👤 | AI | AI | AI |
| human-lead | AI | 👤 | AI | 👤 | 👤 |
| human-only | 👤 | 👤 | 👤 | 👤 | 👤 |

Jira label: `mode:full-auto`, `mode:ai-assist`, `mode:human-lead`, `mode:human-only`.
Ortada değişim: `/mode-change <mode>` (Tech Lead yetkisi).

## Handoff Sinyalleri

- İnsan → AI: `/ai-takeover`, `/ai-write-test`, `/ai-analyze`
- AI → İnsan: otomatik (düşük confidence, bütçe aşımı, 2. ret)

## SLA Zamanlamaları

- **Onay kapıları** (PO, TL, QA): 48h (Jira due date önceliklidir)
- **Clarification**: 72h
- **Reminder**: 24h'de bir

## Geri Dönüşler

- `/reject` analiz onayı → Analyst yeniden (max 3, sonra mimara eskalasyon)
- `/reject` test senaryosu → Test Designer (max 3)
- CI Gate kırmızı → 6a'ya (developer AI bounded retry 1)
- PR comment "request changes" → 6a'ya

## 4-Göz Kuralı

Analiz onaylayan kullanıcı (4. adım) PR onaylayan (12. adım) ile farklı olmalı. İhlal → workflow reject + Jira uyarısı.

## Cost Budget

Her workflow için hard cap (default $5, arka planda). %80'de Agent Studio uyarısı (kullanıcıya görünmez), %100'de workflow durur + Slack kritik + insan müdahalesi bekler.

## Flaky Detection

Test runner 3 koşu yapar; 2 farklı sonuç → flaky flag → insan müdahalesi bekler (workflow reject).

## Coverage Gate

Coverage < %70 → workflow reject + test tasarımına geri (bounded).

## İşletme Notları

- Jira yorum komutları **asenkron** işlenir; workflow signal dispatch edilir, sonra yoruma onay/ret cevabı otomatik düşer (v1.1).
- Workflow cancellation → sandbox container kill + branch silinmez (ops manuel).
- Tüm kararlar **hash-chained audit log**'da. Tamper detect: `GET /audit/verify`.
