# ADR-0001: Temporal İş Akışı Motoru Olarak Seçildi

## Status
Accepted — 2026-Q1

## Context
Orkestra, ticket → PR yolculuğunu 15 adımlı, durum-tutucu (stateful), uzun
ömürlü (saatler-günler), idempotent ve retry-güvenli bir iş akışı olarak
modellemek zorunda. Her adım insan onayı (6 kapı) ile bloklanabilir. Workflow
versiyonlama, crash recovery, deterministik replay ve ephemeral sandbox
tetikleyici entegrasyonu şart.

## Decision
İş akışı motoru olarak **Temporal** (self-hosted, `temporal-server` docker
image) seçildi. Workflow ve activity'ler TypeScript SDK ile yazılacak ve
`apps/worker` içinde host edilecek.

## Consequences
- (+) Durum yönetimi, retry, timeout, child workflow, signal/query hazır.
- (+) Temporal UI ile ops ekibi adım-adım takip edebilir (bkz. runbook).
- (+) Deterministik replay sayesinde deploy sırasında yarım kalan workflow'lar
  sürdürülebilir.
- (−) Ek altyapı bileşeni (Temporal server + postgres). On-prem footprint artar.
- (−) Determinism kuralları öğrenme eğrisi yaratır (side-effect'ler activity'ye
  taşınmalı).
- (−) Workflow versiyonlaması (patched) disiplin gerektirir.

## Alternatives considered
- **BullMQ / Redis queue** — yeterince stateful değil, saga/retry kendi elimizle.
- **Airflow** — Python-merkezli, UI fena değil ama TS ekosistemiyle ters.
- **Kendi workflow motorumuzu yazmak** — kritik sistemde tekerleği yeniden
  icat etmek risk; uzun vadede maliyet.
- **AWS Step Functions** — on-prem kısıtımızı ihlal eder (K9 ile çatışır).

## References
- `plan/projectplan.md` → **K1** (workflow engine seçimi)
- `docs/workflow.md` — 15 adım ve Temporal mapping'i
- `docs/runbook.md` — Temporal UI / worker ops
