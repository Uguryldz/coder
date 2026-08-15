import type { ReactNode } from "react";
import { useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { useApi } from "../../auth/AuthProvider.tsx";
import { useT } from "../../i18n/I18nProvider.tsx";
import { Card } from "../../ui/index.ts";
import "../shared/screens.css";

/**
 * The first-run "where do I start" checklist, shown on the Panel while the
 * platform has no work yet.
 *
 * A manager who just logged in used to see a bare "no workflows yet" message and
 * no idea what to do about it. This card answers that: wire the connections →
 * bind a project (the ready-made listening rules come with it) → train the
 * agents with documents → open a ticket in Jira and watch it here. Each step
 * reports its OWN real state (a connection exists? a project is bound? an agent
 * has knowledge files?) so it is a live checklist, not a static tutorial — a
 * checked step stays checked, and the FIRST unfinished step is highlighted as
 * "do this next".
 *
 * The reads are the same lightweight endpoints the binding screens already use;
 * a failure on any of them just leaves that step unchecked rather than breaking
 * the Panel.
 */

interface StepState {
  readonly done: boolean;
  readonly to: string;
}

export function StartGuide(): ReactNode {
  const t = useT();
  const api = useApi();
  const navigate = useNavigate();

  // Step 1 — at least one Jira OR SCM connection is wired.
  const jiraConns = useQuery({
    queryKey: ["onboarding-jira-connections"],
    queryFn: ({ signal }) =>
      api.get<{ connections: readonly unknown[] }>("/onboarding/jira-connections", { signal }),
    retry: false,
  });
  const scmConns = useQuery({
    queryKey: ["onboarding-scm-connections"],
    queryFn: ({ signal }) =>
      api.get<{ connections: readonly unknown[] }>("/onboarding/scm-connections", { signal }),
    retry: false,
  });
  // Step 2 — at least one project is bound (routing view lists bound projects).
  const routing = useQuery({
    queryKey: ["routing"],
    queryFn: ({ signal }) =>
      api.get<{ projects: readonly unknown[] }>("/routing", { signal }),
    retry: false,
  });
  // Step 3 — at least one agent has been trained with documents (a variant
  // whose knowledge library holds files). The listening rules no longer make a
  // step of their own: binding a project seeds the ready-made rules, so the
  // rule step collapsed into step 2 and the freed slot asks for the one thing
  // only a human can supply — the institution's documents.
  const variants = useQuery({
    queryKey: ["variants"],
    queryFn: ({ signal }) =>
      api.get<{ variants: readonly { knowledgeFiles?: number }[] }>("/variants", { signal }),
    retry: false,
  });

  const hasConn =
    (jiraConns.data?.connections.length ?? 0) > 0 || (scmConns.data?.connections.length ?? 0) > 0;
  const hasBinding = (routing.data?.projects.length ?? 0) > 0;
  const hasTrainedAgent = (variants.data?.variants ?? []).some(
    (v) => (v.knowledgeFiles ?? 0) > 0,
  );

  const steps: readonly StepState[] = [
    { done: hasConn, to: "/settings" },
    { done: hasBinding, to: "/projects?tab=onboard" },
    { done: hasTrainedAgent, to: "/variants" },
    { done: false, to: "/pilot" }, // "watch" — never auto-checked; it is the goal
  ];
  // The first step that is not done yet is the one to nudge.
  const nextIdx = steps.findIndex((s) => !s.done);

  return (
    <Card title={t("dash.start.title")} subtitle={t("dash.start.sub")}>
      <ol className="dash-start">
        {steps.map((step, i) => {
          const isNext = i === nextIdx;
          return (
            <li key={i} className="dash-start__item">
              <button
                type="button"
                className={
                  "dash-start__step" +
                  (step.done ? " dash-start__step--done" : "") +
                  (isNext ? " dash-start__step--next" : "")
                }
                onClick={() => navigate(step.to)}
              >
                <span className="dash-start__mark" aria-hidden="true">
                  {step.done ? "✓" : i + 1}
                </span>
                <span className="dash-start__body">
                  <span className="dash-start__label">{t(`dash.start.step${i + 1}.title`)}</span>
                  <span className="dash-start__hint">{t(`dash.start.step${i + 1}.hint`)}</span>
                </span>
                {isNext && <span className="dash-start__cta">{t("dash.start.do_this")}</span>}
              </button>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}
