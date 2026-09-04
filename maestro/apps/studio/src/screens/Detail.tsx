import { useState } from "react";
import type { ReactNode } from "react";
import { useParams } from "react-router";
import { useT } from "../i18n/I18nProvider.tsx";
import { ButtonLink, Card, TabPanel, Tabs } from "../ui/index.ts";
import { AnalysisTab } from "./detail/AnalysisTab.tsx";
import { CostTab } from "./detail/CostTab.tsx";
import { JournalTab } from "./detail/JournalTab.tsx";
import { RunSidebar } from "./detail/RunSidebar.tsx";
import { StepList } from "./detail/StepList.tsx";
import { isTerminal } from "./detail/run-state.ts";
import { NotAvailable, QueryState } from "./shared/QueryState.tsx";
import { RunStatusCell } from "./shared/RunStatusCell.tsx";
import { useRunDetail } from "./shared/runs.ts";

/**
 * Screen: detail/:ticket — one workflow, in full. The URL is the state, so a
 * gate reminder can point straight at the run that needs a decision.
 *
 * `GET /studio/runs/:ticket` returns the catalog record, the live workflow
 * state (or `null` for a ticket whose workflow has not started) and the
 * application the ticket was matched to. 404 `no_run` and 403 `project_access`
 * surface through QueryState as translated sentences.
 *
 * Four tabs, each with a data source: steps (the state), journal and analysis
 * (`/journal`), consumption (`/cost`). There is no change-summary or test-result
 * endpoint, so there is no tab for them — a tab that can only say "elsewhere"
 * is not a tab.
 */

const TAB_IDS = ["steps", "journal", "analysis", "cost"] as const;
type TabId = (typeof TAB_IDS)[number];

export function DetailScreen(): ReactNode {
  const t = useT();
  const { ticket } = useParams<{ ticket: string }>();
  const [tab, setTab] = useState<TabId>("steps");

  const { data: detail, isPending, error, refetch } = useRunDetail(ticket);

  if (ticket === undefined || ticket === "") {
    return <NotAvailable detailKey="detail.no_ticket" />;
  }

  return (
    <QueryState isPending={isPending} error={error} onRetry={() => void refetch()} skeletonRows={8}>
      {detail === undefined ? null : (
        <div className="scr-stack">
          <div className="scr-row">
            <ButtonLink to="/dash" size="sm" variant="ghost">
              ← {t("detail.back")}
            </ButtonLink>
            <b className="scr-mono">{detail.run.ticketKey}</b>
            <span>{detail.run.title}</span>
            <RunStatusCell status={detail.state?.status ?? null} />
          </div>

          <div className="scr-grid scr-grid--detail">
            <Card padded={false}>
              <Tabs
                label={t("detail.tabs.label")}
                active={tab}
                onChange={(id) => setTab(id as TabId)}
                items={TAB_IDS.map((id) => ({ id, label: t(`detail.tab.${id}`) }))}
              />
              <div className="ui-card__bd">
                <TabPanel id="steps" active={tab}>
                  {detail.state === null ? (
                    <NotAvailable detailKey="detail.steps.not_started" />
                  ) : (
                    <>
                      {/* A position read from the record is real progress,
                          possibly stale — worth a line while the run is
                          alive. A FINISHED run has nothing to be stale
                          about: its last record IS its final position. */}
                      {detail.stateSource === "record" && !isTerminal(detail.state) && (
                        <p className="scr-hint scr-hint--warn">{t("detail.steps.from_record")}</p>
                      )}
                      <StepList run={detail.state} />
                    </>
                  )}
                </TabPanel>
                <TabPanel id="journal" active={tab}>
                  <JournalTab ticket={ticket} />
                </TabPanel>
                <TabPanel id="analysis" active={tab}>
                  <AnalysisTab ticket={ticket} />
                </TabPanel>
                <TabPanel id="cost" active={tab}>
                  <CostTab ticket={ticket} />
                </TabPanel>
              </div>
            </Card>

            <RunSidebar
              record={detail.run}
              state={detail.state}
              application={detail.application}
              {...(detail.stateSource === undefined ? {} : { stateSource: detail.stateSource })}
            />
          </div>
        </div>
      )}
    </QueryState>
  );
}
