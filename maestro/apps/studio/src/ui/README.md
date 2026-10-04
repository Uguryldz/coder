# Studio design system

Shared primitives for every Studio screen. Import from the barrel:

```tsx
import { Button, Card, Table, Badge } from "../ui/index.ts";
```

Each primitive is one file, each under 300 lines, styled with plain CSS files
that use the tokens in `tokens.css`.

## Why plain CSS files and not Tailwind / CSS Modules

The visual contract started as `mock/index.html`; the palette has since been
cut down on purpose (operator's brief: compact, calm, colour only for state).
`tokens.css` carries ONE primary (`--blue`), ONE accent (`--purple`), THREE
states (`--green` / `--amber` / `--red`) and a grey ramp — nothing else. There
is no dark theme (the tokens for one were never wired and were deleted).

- **Not Tailwind**: the mock's palette and spacing would have to be re-encoded
  as a Tailwind theme, and every value re-checked against the design. Tailwind
  also puts the styling in the TSX, which makes a 300-line budget harder to
  keep and the diff against the mock harder to read.
- **Not CSS Modules**: they solve name collisions, and we have none. Every class
  is prefixed (`ui-btn`, `ui-card__hd`, `shell__nav`), which gives the same
  isolation with no build-time indirection, and it means a class in devtools has
  the same name as the class in the source.
- Tokens live in `tokens.css` and are imported once by `src/app/App.tsx`. Never
  write a literal colour in a component — use `var(--blue)` etc.
- Screen-level layout helpers (`scr-stack`, `scr-grid--2`, `scr-kv`, `scr-note`,
  `scr-hint`, `scr-mono`, `scr-chips`, …) live in ONE file,
  `src/screens/shared/screens.css`, loaded once by `App.tsx`. Screens import no
  CSS. The old `screen-*` and `tpl-keyline/tpl-chips` names are gone.

## Rules for screen agents

1. **No literal user-visible strings.** Every label, heading, button, empty
   state and error you pass into these components must come from the catalog:
   `const t = useT(); <Button>{t("action.save")}</Button>`. The primitives take
   already-translated strings on purpose — they never call `t` themselves.
2. **Add catalog keys to BOTH `tr.json` and `en.json`** in
   `packages/config/locales/`. Parity is enforced by a test in
   `@maestro/config`, and a missing key throws at render (no silent fallback).
3. **Fetch through `useApi()` + TanStack Query**, never bare `fetch`. See
   "Data fetching" below.
4. **Use the domain tone helpers** (`runStatusTone`, `riskTone`,
   `workModeTone`) so the same status is the same colour on every screen.
5. Keep each screen file under 300 lines; split into `src/screens/<id>/` if it
   grows.
6. **Calm by default.** Red and amber (`scr-note--danger`, `scr-note--warn`,
   `tone="red"|"amber"`) only when something is actually wrong. Information is
   grey (`scr-hint`, `scr-note`, `tone="gray"`). Prefer `<Section>` over `<Card>`
   for anything that is not a distinct panel; prefer a `<ListRow>` list over a
   card per item.
7. **Every write invalidates through `invalidateRun(queryClient, ticket)`**
   (`src/screens/shared/runs.ts`) when it touches a run. Do not spell query keys
   by hand — that is how the detail screen stopped refreshing for a month.

## Components

### Button
```tsx
<Button variant="primary" size="sm" busy={saving} onClick={save}>{t("action.save")}</Button>
```
- `variant`: `"default" | "primary" | "success" | "danger" | "ghost" | "link"`.
  `ghost` = no chrome (an action in a table cell / card header); `link` = reads
  as an inline link but IS a button (replaces the old `scr-linkbtn` markup).
- `size`: `"md" | "sm"`
- `busy`: disables and sets `aria-busy`; use while a mutation is in flight.
- Defaults to `type="button"`, so it never submits a form unless you say so.

### ButtonLink
```tsx
<ButtonLink to="/setup" variant="primary" size="sm">{t("dash.open_wizard")}</ButtonLink>
```
A router `<Link>` dressed as a button, for navigation. Never write
`<Link className="ui-btn">` by hand.

### Input / TextArea / Select
```tsx
<Input label={t("login.username")} value={v} onChange={e => setV(e.target.value)} />
<TextArea label={t("field.reason")} rows={3} error={t("error.reject_needs_reason")} />
<Select label={t("shell.language")} value={locale} onChange={...}
        placeholder={t("field.choose")}
        options={[{ value: "tr", label: t("locale.tr") }]} />
```
- `label`, `hint`, `error` are already-translated strings.
- `error` sets `aria-invalid` and replaces the hint. Label and description are
  wired to the control by id, so `getByLabelText` works in tests.
- `TextArea` for anything a person writes in sentences (a reason, an answer, a
  JSON value) — never a single-line `Input` for those.
- `Select.placeholder` renders a first row with an empty value, so a field that
  starts unset does not silently pre-pick the first option.

### FieldGroup
```tsx
<FieldGroup legend={t("connections.group.auth")} hint={…} columns={2}>
  <Input label={…} /> <Input label={…} />
</FieldGroup>
```
A real `<fieldset>` + legend. Group a long form into named blocks (auth fields,
address fields, schedule) instead of one flat column of twelve inputs.

### Card / Section / Kpi
```tsx
<Card title={t("card.attention")} subtitle={t("card.last24h")} actions={<Button size="sm">…</Button>}>
  body
</Card>
<Section title={t("settings.group.smtp")}>…</Section>
<Kpi label={t("kpi.active_flows")} value="12" note={t("kpi.note", { n: "3" })} />
```
- `padded={false}` when the body is a `<Table>` or a `<ListRow>` list that
  should run edge to edge.
- `Section` is a titled block WITHOUT a box — the calmer default for anything
  that is not a distinct panel. A page of six small cards is six borders too many.

### ListRow
```tsx
<div className="ui-list">
  {rows.map(r => (
    <ListRow key={r.id}
      status={<Badge tone={r.ok ? "green" : "red"}>{…}</Badge>}
      title={r.displayName} kind={t(`connections.kind.${r.kind}`)}
      meta={<><span>{t("connections.last_test", { when })}</span></>}
      actions={<><Button size="sm" variant="ghost">…</Button></>}
      onClick={() => open(r)} />
  ))}
</div>
```
One entity per line: status · name · kind · meta · actions. The list layout for
connections, users, rules — anywhere a card per item was too heavy. Clicks on
the actions never bubble to the row.

### Badge
```tsx
<Badge tone={runStatusTone(run.status)}>{t(`run.status.${run.status}`)}</Badge>
```
- `tone`: `blue | green | amber | red | purple | teal | orange | gray`. `teal`
  and `orange` render as neutral greys now (see tokens.css) — use `gray` in new
  code; `purple` is the one accent, for "AI-driven".
- Helpers: `runStatusTone` (covers both BFF status vocabularies — Temporal-level
  `completed/failed/...` and domain-level `gate/fail/done/...`), `riskTone`
  (`dusuk/orta/kritik`), `workModeTone` (`full_auto/ai_assist/human_lead/human_only`).

### Table
```tsx
<Table
  columns={[
    { key: "ticket", header: t("col.ticket"), cell: r => r.ticketKey },
    { key: "status", header: t("col.status"), cell: r => <Badge tone={runStatusTone(r.status)}>…</Badge> },
    { key: "age", header: t("col.age"), cell: r => r.age, align: "right" },
  ]}
  rows={runs}
  rowKey={r => r.runId}
  onRowClick={r => navigate(`/detail/${r.ticketKey}`)}
  loading={isPending}
  emptyLabel={t("empty.no_data")}
/>
```
- Generic over the row type; `cell` is fully typed.
- `rowKey` is required — never key on the array index.
- Renders its own `<Skeleton>` while `loading` and its own `<EmptyState>` when
  `rows` is empty, so list screens need no branching.
- `onRowClick` rows are focusable and keyboard-activatable (Enter/Space); they
  stay `<tr>`s (no `role="button"`), so cells may carry their own buttons.

### Tabs / TabPanel
```tsx
const [tab, setTab] = useState("analysis");
<Tabs label={t("tabs.detail")} active={tab} onChange={setTab}
      items={[{ id: "analysis", label: t("tab.analysis"), count: 3 }]} />
<TabPanel id="analysis" active={tab}>…</TabPanel>
```
Controlled, so you can put the active tab in the URL for deep links. One tab
stop; Left/Right/Home/End move between tabs (WAI-ARIA tabs pattern).

### Modal
```tsx
<Modal open={open} onClose={close} title={t("modal.confirm")} closeLabel={t("action.close")}
       footer={<><Button onClick={close}>{t("action.cancel")}</Button>
                 <Button variant="danger" onClick={confirm}>{t("action.confirm")}</Button></>}>
  body
</Modal>
```
A real `<dialog>`: focus trapping, Escape and the top layer come from the
platform. Backdrop click closes. Renders nothing while `open` is false.

### Toast
```tsx
const toast = useToast();
toast.show("success", t("toast.saved"));
toast.show("error", t(messageKeyOf(error)));   // never raw server text
```
`tone`: `info | success | warning | error`. Errors persist until dismissed;
everything else auto-dismisses after 6s. The close button is labelled
`action.close`.

### EmptyState / Skeleton
```tsx
<EmptyState icon="📭" title={t("empty.no_runs")} description={t("empty.no_runs_hint")}
            action={<Button variant="primary">{t("action.create")}</Button>} />
<Skeleton rows={5} />
```

## Data fetching

```tsx
const api = useApi();
const { data, isPending, error } = useQuery({
  queryKey: ["studio-users"],
  queryFn: ({ signal }) => api.get<UsersView>("/studio/users", { signal }),
});
// Runs: use the hooks in src/screens/shared/runs.ts (useRuns / useRunDetail /
// useJournal) and invalidate with invalidateRun(queryClient, ticket).
```
- Always forward `signal` so a superseded or unmounted query is cancelled.
- Paths are relative to the BFF root (`/runs`, `/params`); the client prefixes
  `/api`, which the dev server proxies to `localhost:7001`.
- On 401 the client clears the session and the app routes to `/login` — you do
  not handle that yourself.
- To show a failure: `t(messageKeyOf(error))` from `src/api/errors.ts`. Never
  render `error.message` or any server string. `<QueryState>`
  (`src/screens/shared/QueryState.tsx`) does loading / error / empty in one go.
- A 404 is "no such record" and renders as that error. There is no "henüz
  yayında değil" state any more: every endpoint the app calls exists.
- 401 / 403 / 404 / 501 and `503 capability_not_wired` are never retried.

## Errors on screen

Every route renders inside a per-screen `ErrorBoundary` (Shell.tsx) keyed on
the path: a screen that throws shows a red panel with a "Geri dön" button and
the menu stays usable; navigating away clears it. The app-level boundary in
App.tsx is the last resort for a failure in the chrome itself.

## Accessibility

The mock has no focus styles; `tokens.css` adds a `:focus-visible` ring. Keep
interactive things as real `<button>`/`<a>` elements, give icon-only controls an
`aria-label` from the catalog, and prefer these primitives over ad-hoc markup so
the keyboard and screen-reader behaviour stays consistent.
