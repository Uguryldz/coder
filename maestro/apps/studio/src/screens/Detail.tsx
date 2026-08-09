import { useState } from "react";
import type { ReactNode } from "react";
import { useParams } from "react-router";
import { useT } from "../i18n/I18nProvider.tsx";
import { Card, TabPanel, Tabs } from "../ui/index.ts";
import { JournalTab } from "./detail/JournalTab.tsx";
import { RunSidebar } from "./detail/RunSidebar.tsx";
import { StepList } from "./detail/StepList.tsx";
import { NotAvailable, QueryState } from "./shared/QueryState.tsx";
import { useRunState } from "./shared/runs.ts";
import "./shared/screens.css";

/**
 * Screen: detail/:ticket — one workflow, in full.
 *
 * Route param, not module state: the mock keeps the selected ticket in a global
 * (`DKEY`), which makes the view unlinkable. Here the URL is the state, so a
 * gate reminder can point straight at the run that needs a decision.
 *
 * `GET /runs/:ticket` answers 404 `no_run` for a ticket Maestro never ran and
 * 403 `project_access` for one the caller may not see — both surface through
 * QueryState as translated sentences, never as a raw code.
 */

const TAB_IDS = ["steps", "journal", "analysis", "diff", "tests", "cost"] as const;
type TabId = (typeof TAB_IDS)[number];

export function DetailScreen(): ReactNode {
  const t = useT();
  const { ticket } = useParams<{ ticket: string }>();
  const [tab, setTab] = useState<TabId>("steps");

  const { data: run, isPending, error, refetch } = useRunState(ticket);

  if (ticket === undefined || ticket === "") {
    return <NotAvailable detailKey="detail.no_ticket" />;
  }

  return (
    <QueryState isPending={isPending} error={error} onRetry={() => void refetch()} skeletonRows={8}>
      {run === undefined ? null : (
        <div className="screen-grid screen-grid--detail">
          <Card padded={false}>
            <Tabs
              label={t("detail.tabs.label")}
              active={tab}
              onChange={(id) => setTab(id as TabId)}
              items={TAB_IDS.map((id) => ({ id, label: t(`detail.tab.${id}`) }))}
            />
            <div style={{ padding: 14 }}>
              <TabPanel id="steps" active={tab}>
                <StepList run={run} />
              </TabPanel>
              <TabPanel id="journal" active={tab}>
                <JournalTab ticket={ticket} />
              </TabPanel>
              <TabPanel id="analysis" active={tab}>
                <NotAvailable detailKey="detail.analysis.unavailable" />
              </TabPanel>
              <TabPanel id="diff" active={tab}>
                <NotAvailable detailKey="detail.diff.unavailable" />
              </TabPanel>
              <TabPanel id="tests" active={tab}>
                <NotAvailable detailKey="detail.tests.unavailable" />
              </TabPanel>
              <TabPanel id="cost" active={tab}>
                <NotAvailable detailKey="detail.cost.unavailable" />
              </TabPanel>
            </div>
          </Card>

          <RunSidebar run={run} />
        </div>
      )}
    </QueryState>
  );
}
