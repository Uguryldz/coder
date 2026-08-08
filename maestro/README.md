# Maestro

Jira ile tetiklenen, insan onay kapılı, AI destekli SDLC otomasyon platformu (kurum içi).

- **Plan:** [`plan/masterplan.md`](plan/masterplan.md) (M1–M104) · inşa modeli: [`plan/insa-plani.md`](plan/insa-plani.md)
- **UI prototipi:** [`mock/index.html`](mock/index.html) — Studio ekranlarının spec'i
- **Kod:** `packages/*` (çekirdek) + `apps/*` (bff · worker · runner-agent · studio)

## Geliştirme

```bash
pnpm install
pnpm check   # lint + typecheck + test
```

`packages/contracts` ve `packages/ports` **donuktur** (Dalga 0 kapısı sonrası):
değişiklik yalnız orkestratör kararıyla yapılır — bkz. `plan/insa-plani.md` §2.

© 2026 Uğur Yıldız — bkz. [LICENSE](LICENSE).
