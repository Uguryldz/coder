import type { ReactNode } from "react";
import { Link } from "react-router";
import { useT } from "../i18n/I18nProvider.tsx";
import { Card, Table } from "../ui/index.ts";

/**
 * Screen: help — how Maestro is used, by role.
 *
 * This is the one screen in the cluster with no data layer: it is documentation,
 * so every sentence is a catalog entry and there is nothing to fetch. That also
 * means it has no loading or error state to handle — deliberately, not by
 * omission.
 */

/** Role guides, and where each role should go next. */
const ROLES: readonly { readonly id: string; readonly to: string }[] = [
  { id: "business", to: "/jira" },
  { id: "developer", to: "/workmode" },
  { id: "admin", to: "/settings" },
];

/** Jira comment commands. Descriptions live in the catalog. */
const COMMANDS: readonly string[] = [
  "approve",
  "reject",
  "status",
  "ai_explain",
  "ai_start",
  "ai_assign",
  "mode_change",
  "ai_takeover",
];

/** Ordered first-time setup steps for an admin. */
const SETUP_STEPS: readonly string[] = ["connections", "webhook", "permissions", "app", "binding", "dry_run"];

export function HelpScreen(): ReactNode {
  const t = useT();

  return (
    <>
      <Card title={t("help.in_one_paragraph")}>
        <p>{t("help.summary")}</p>
      </Card>

      <div style={{ marginTop: 14 }}>
        <Card title={t("help.by_role")}>
          <div className="tpl-chips">
            {ROLES.map((role) => (
              <section key={role.id} style={{ flex: "1 1 220px" }}>
                <b>{t(`help.role.${role.id}`)}</b>
                <p className="tpl-keyline">{t(`help.role_desc.${role.id}`)}</p>
                <Link to={role.to}>{t(`help.role_link.${role.id}`)}</Link>
              </section>
            ))}
          </div>
        </Card>
      </div>

      <div style={{ marginTop: 14 }}>
        <Card title={t("help.analysis_walkthrough")} subtitle={t("help.analysis_walkthrough_sub")}>
          <ol>
            {["open", "answer", "review", "decide", "after"].map((step) => (
              <li key={step}>{t(`help.analysis_step.${step}`)}</li>
            ))}
          </ol>
        </Card>
      </div>

      <div style={{ marginTop: 14 }}>
        <Card title={t("help.setup")} subtitle={t("help.setup_sub")}>
          <ol>
            {SETUP_STEPS.map((step) => (
              <li key={step}>{t(`help.setup_step.${step}`)}</li>
            ))}
          </ol>
        </Card>
      </div>

      <div style={{ marginTop: 14 }}>
        <Card title={t("help.commands")} subtitle={t("help.commands_sub")} padded={false}>
          <Table
            columns={[
              {
                key: "command",
                header: t("help.col.command"),
                cell: (row: string) => <code>{t(`help.command.${row}`)}</code>,
              },
              {
                key: "what",
                header: t("help.col.what"),
                cell: (row) => t(`help.command_desc.${row}`),
              },
            ]}
            rows={COMMANDS}
            rowKey={(row) => row}
            emptyLabel={t("empty.no_data")}
          />
        </Card>
      </div>

      <div style={{ marginTop: 14 }}>
        <Card title={t("help.knowledge")} subtitle={t("help.knowledge_sub")}>
          <p>{t("help.knowledge_body")}</p>
          <p className="tpl-keyline">{t("help.safety_rails")}</p>
          <Link to="/knowledge">{t("help.knowledge_link")}</Link>
        </Card>
      </div>

      <div style={{ marginTop: 14 }}>
        <Card title={t("help.troubleshooting")}>
          <ul>
            {["rejected", "stuck", "wrong_app", "quota"].map((item) => (
              <li key={item}>{t(`help.trouble.${item}`)}</li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}
