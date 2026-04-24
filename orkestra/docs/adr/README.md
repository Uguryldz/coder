# Architecture Decision Records (ADR)

Bu dizin, Jira AI Orkestra için alınmış mimari kararları **immutable** birer
doküman olarak tutar. ADR, Michael Nygard'ın orijinal formatına yakın, kısa ve
odaklıdır — roman değil, karar kaydı.

## Ne zaman ADR yazılır?

- Geri dönmesi pahalı bir teknik seçim yapıldığında (framework, protokol,
  deployment modeli, veri formatı)
- `plan/projectplan.md` içindeki bir kararın (K1–K49) **niçinini** detaylandırmak
  gerektiğinde
- Bir önceki ADR süperse ediliyorsa (yeni ADR açılır, eski `Status: Superseded`
  olarak güncellenir — içerik silinmez)

## Dosya Adlandırma

`NNNN-kisa-slug.md` — sıralı, 4 haneli, tire ile.

## Şablon / Template

Her ADR aşağıdaki bölümleri içerir ve **50 satırı geçmemeye** çalışır:

```markdown
# ADR-NNNN: <Başlık>

## Status
Accepted | Proposed | Superseded by ADR-XXXX | Deprecated

## Context
Kararı gerektiren durum: kısıtlar, hedefler, dış faktörler.

## Decision
Alınan karar — net, tek cümle tercih edilir.

## Consequences
Pozitif, negatif ve nötr etkiler. Takas yapılan şey.

## Alternatives considered
Değerlendirilip reddedilen seçenekler + kısa red gerekçesi.

## References
`plan/projectplan.md#K##`, issue, prototip dal, dış link.
```

## Dizin

| # | Başlık | Status | Plan Ref |
|---|--------|--------|----------|
| 0001 | Temporal as Workflow Engine | Accepted | K1 |
| 0002 | TypeScript Monorepo (Reject Python) | Accepted | K2, K44 |
| 0003 | Ephemeral Docker Sandbox (Not E2B) | Accepted | K8 |
| 0004 | Knowledge Pack per Variant | Accepted | K13, K43 |
| 0005 | Single-Tenant Deployment | Accepted | K9 |

## Süperse Etme / Superseding

Bir ADR'yi değiştirmek yerine yeni bir ADR aç, eskisinin `Status`'ünü
`Superseded by ADR-NNNN` yap ve `References` bölümüne link koy. Eski dosya
silinmez — tarih kaydı olarak kalır.
