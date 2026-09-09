import type { ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { useT } from "../i18n/I18nProvider.tsx";
import { Card, TabPanel, Tabs } from "../ui/index.ts";
import { JiraCommandsSection } from "./help/JiraCommands.tsx";
import { JiraSetupCard } from "./help/JiraSetup.tsx";
import { McpServerSection } from "./help/McpServer.tsx";

/**
 * Screen: help — a guided reference to the whole platform, one tab per menu
 * GROUP, mirroring the sidebar's five groups (İşler / Ajanlar / Projeler /
 * Denetim / Yönetim — see app/screens.ts), plus two reference tabs that used
 * to be screens of their own: the Jira command set and the Maestro MCP server.
 * Each group tab lists that group's pages, and every page is explained the
 * same way an operator asks about it: NE İŞE YARAR (what it is for), NASIL
 * ÇALIŞIR (how it works), ÖRNEK (a concrete example). Above the tabs, a
 * "capabilities" card walks through the newer behaviours — auto-start on
 * binding, the two approval paths, per-agent training, the clarification loop
 * and the audit CSV export.
 *
 * The guide itself has no data layer — every sentence is a catalog entry. The
 * three reference parts (Jira setup, commands, MCP) read the live BFF so they
 * cannot drift from what the platform actually accepts. The active tab lives
 * in the URL (`?cat=`) so a deep link lands on a category.
 */

interface Category {
  readonly id: string;
  /** Catalog key of the tab label. */
  readonly labelKey: string;
  /** The page guides this tab lists; empty for a reference tab. */
  readonly pages: readonly string[];
}

/**
 * The category tabs, in the sidebar's order (app/screens.ts NAV_GROUPS), each
 * with the pages it explains — the same pages the sidebar puts in that group,
 * plus the routable-but-hidden `params`. Group labels come from the SAME
 * `nav.group.*` catalog keys the sidebar renders, so the guide can never name
 * a group the menu does not. The last two are reference tabs (no page guides):
 * their content is a component, chosen by id in REFERENCE below.
 */
const CATEGORIES: readonly Category[] = [
  { id: "start", labelKey: "nav.group.start", pages: ["dash", "sandbox"] },
  { id: "ai", labelKey: "nav.group.ai", pages: ["variants", "knowledge", "template", "doctemplate"] },
  { id: "projects", labelKey: "nav.group.projects", pages: ["projects", "listening"] },
  { id: "compliance", labelKey: "nav.group.compliance", pages: ["audit", "pii", "aiusage", "evidence"] },
  { id: "admin", labelKey: "nav.group.admin", pages: ["settings", "notify", "params", "users", "health"] },
  { id: "commands", labelKey: "help.tab.commands", pages: [] },
  { id: "mcp", labelKey: "help.tab.mcp", pages: [] },
];

/** The reference tabs' content — the old /commands and /mcp screens. */
const REFERENCE: Readonly<Record<string, () => ReactNode>> = {
  commands: JiraCommandsSection,
  mcp: McpServerSection,
};

/** The newer platform behaviours the guide walks through, in reading order. */
const FEATURES = ["autostart", "approval", "training", "clarify", "auditcsv"] as const;

/** The page a page-guide links to ("Ekrana git"), by page id. */
const PAGE_LINK: Readonly<Record<string, string>> = {
  dash: "/dash",
  projects: "/projects",
  listening: "/projects?tab=listening",
  template: "/template",
  doctemplate: "/doctemplate",
  notify: "/notify",
  knowledge: "/knowledge",
  audit: "/audit",
  evidence: "/evidence",
  pii: "/pii",
  aiusage: "/cost",
  variants: "/variants",
  users: "/users",
  settings: "/settings",
  params: "/params",
  health: "/health",
  sandbox: "/sandbox",
};

const CAT_IDS = CATEGORIES.map((c) => c.id);

function isCat(value: string | null): boolean {
  return value !== null && CAT_IDS.includes(value);
}

export function HelpScreen(): ReactNode {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const raw = params.get("cat");
  const active = isCat(raw) ? (raw as string) : "start";

  const select = (id: string): void => {
    const next = new URLSearchParams(params);
    next.set("cat", id);
    setParams(next, { replace: false });
  };

  return (
    <div className="scr-stack">
      <Card title={t("help.title")} subtitle={t("help.subtitle")}>
        <p className="scr-prose">{t("help.summary")}</p>
      </Card>

      {/* "What do I do in Jira?" comes first: a ticket that never reaches
          Maestro makes every other page moot. Its content is read from the
          live listening rules, not written here. */}
      <JiraSetupCard />

      <Card title={t("help.features")} subtitle={t("help.features_sub")}>
        <div className="help-guide">
          {FEATURES.map((feature) => (
            <section key={feature} className="help-guide__block">
              <h4 className="help-guide__h">{t(`help.feature.${feature}.title`)}</h4>
              <p className="scr-prose">{t(`help.feature.${feature}.body`)}</p>
            </section>
          ))}
        </div>
      </Card>

      <Tabs
        label={t("help.tabs.label")}
        active={active}
        onChange={select}
        items={CATEGORIES.map((c) => ({ id: c.id, label: t(c.labelKey) }))}
      />

      {CATEGORIES.map((category) => {
        const Reference = REFERENCE[category.id];
        return (
          <TabPanel key={category.id} id={category.id} active={active}>
            {Reference !== undefined ? (
              <Reference />
            ) : (
              <div className="scr-stack">
                {category.pages.map((page) => (
                  <PageGuide key={page} page={page} />
                ))}
              </div>
            )}
          </TabPanel>
        );
      })}
    </div>
  );
}

/**
 * One page's guide: title, then the three sections every operator asks for.
 * The example is collapsible-free (always shown) — it is the part that makes the
 * abstract concrete, so hiding it would defeat the point.
 */
function PageGuide({ page }: { readonly page: string }): ReactNode {
  const t = useT();
  const link = PAGE_LINK[page];
  return (
    <Card title={t(`help.page.${page}.title`)}>
      <div className="help-guide">
        <section className="help-guide__block">
          <h4 className="help-guide__h">{t("help.label.purpose")}</h4>
          <p className="scr-prose">{t(`help.page.${page}.purpose`)}</p>
        </section>
        <section className="help-guide__block">
          <h4 className="help-guide__h">{t("help.label.how")}</h4>
          <p className="scr-prose">{t(`help.page.${page}.how`)}</p>
        </section>
        <FieldsBlock page={page} />
        <section className="help-guide__block help-guide__block--example">
          <h4 className="help-guide__h">{t("help.label.example")}</h4>
          <p className="scr-prose">{t(`help.page.${page}.example`)}</p>
        </section>
      </div>
      {link !== undefined && (
        <p style={{ marginTop: 10 }}>
          <Link to={link}>{t("help.goto")}</Link>
        </p>
      )}
    </Card>
  );
}

/**
 * The "alanlar & adımlar" block: the page's fields/buttons, one per line. The
 * catalog entry is a single multi-line string (one field per `\n`), each line
 * `**Alan adı** — ne yazılır, örnek…`. Kept as one entry rather than N keys so a
 * page's field list is edited in one place and the count can vary per page.
 */
function FieldsBlock({ page }: { readonly page: string }): ReactNode {
  const t = useT();
  const raw = t(`help.page.${page}.fields`).trim();
  if (raw === "" || raw === "-") return null; // a screen with nothing to fill in
  const lines = raw.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  return (
    <section className="help-guide__block">
      <h4 className="help-guide__h">{t("help.label.fields")}</h4>
      <ul className="help-fields">
        {lines.map((line, i) => (
          <li key={i}>{renderFieldLine(line)}</li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Renders a field line, turning every `**bold**` span into a real <b> — a field
 * name may appear at the start ("**Kimlik**") or mid-sentence ("Form: **id** …"),
 * so all of them are emphasised, not just a leading one.
 */
function renderFieldLine(line: string): ReactNode {
  const parts = line.split(/(\*\*[^*]+\*\*)/g).filter((p) => p.length > 0);
  return (
    <>
      {parts.map((part, i) => {
        const m = /^\*\*([^*]+)\*\*$/.exec(part);
        return m !== null ? <b key={i}>{m[1]}</b> : <span key={i}>{part}</span>;
      })}
    </>
  );
}
