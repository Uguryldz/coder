# ADR-0003: Ephemeral Docker Sandbox (E2B / Dış Sandbox Reddedildi)

## Status
Accepted — 2026-Q1

## Context
AI ajanlar üretilen kodu derleme, test etme ve güvenlik taraması amacıyla
izole bir ortamda çalıştırmak zorunda. Bu ortam; (a) her koşu için izole ve
tek-kullanımlık, (b) ağ erişimi default kapalı, (c) CPU/RAM/time limitli,
(d) on-prem, (e) müşteri hiçbir şekilde üçüncü parti buluta kod sızdırmaz
olmalı. Single-tenant on-prem kısıtı (ADR-0005 / K9) dış SaaS sandbox'ları
baştan eler.

## Decision
Sandbox katmanı, host Docker daemon'u üzerinden **ephemeral container**
oluşturan, `packages/sandbox` altındaki kendi soyutlamamız olacak. Her `run`
için yeni container, bitişte `docker rm -f`. Default `--network=none`,
allowlist'li outbound için explicit profil. Kaynak limitleri
(`--cpus`, `--memory`, timeout) kararın parçası.

## Consequences
- (+) Kod / sırlar asla müşteri ağı dışına çıkmaz.
- (+) Docker zaten deploy stack'ımızda var; yeni bağımlılık yok.
- (+) Snapshot / cache imajları ile warm-start mümkün.
- (−) Docker-in-Docker veya host socket erişimi operatör tarafında güvenlik
  değerlendirmesi gerektirir; socket proxy + read-only mount ile azaltıldı.
- (−) E2B / Daytona gibi hazır sandbox'ların "out-of-the-box" UX'i yok;
  zamanlayıcı/limitleyici/logger'ı kendimiz yazıyoruz.

## Alternatives considered
- **E2B** — SaaS, kod müşteri ağı dışına çıkar → on-prem politikasıyla çelişir.
- **Firecracker microVM** — daha güçlü izolasyon ama ops yükü + KVM bağımlılığı
  enterprise on-prem kurulumunda sorun.
- **gVisor / Kata containers** — opsiyon olarak ileride eklenebilir; MVP'de
  Docker + seccomp yeterli.

## References
- `plan/projectplan.md` → **K8** (sandbox çalışma zamanı)
- `packages/sandbox/README.md` (yayınlandığında)
- ADR-0005 (single-tenant gereksinimi)
