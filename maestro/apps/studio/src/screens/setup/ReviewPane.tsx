import type { ReactNode } from "react";
import { useT } from "../../i18n/I18nProvider.tsx";
import { Button, ButtonLink, Card } from "../../ui/index.ts";
import { matchValueLabel } from "../common/jira-english.ts";
import { displayMatchValue, type MatchValueOption } from "../common/match-value.ts";
import { STATUS_POINTS, buildStatusMap, gateMirror } from "../common/status-map.ts";
import { bindsNoRepository, flowNeedsRepository, intakePolls, type SetupDraft } from "./model.ts";

/**
 * Step 5 — "Özet & kaydet".
 *
 * Written as SENTENCES, not a key/value dump of the draft. Every line is
 * derived from the same wire bodies the save will send (`buildStatusMap`,
 * `gateMirror`), so a summary that says something the wizard will not actually
 * do is a bug in one place instead of five.
 */

export interface ReviewPaneProps {
  readonly draft: SetupDraft;
  /**
   * Whether the project is ALREADY bound. A second rule on a bound project
   * skips the four-eyes proposal, and the summary must say which of the two
   * things is about to happen.
   */
  readonly alreadyBound: boolean;
  /** Whether a changed command-intake setting takes effect without a restart; `undefined` while unknown. */
  readonly intakeAppliesLive?: boolean | undefined;
  /**
   * The live values with their ids: on a team-managed project the draft holds
   * the ID the rule will store, and the summary must print the NAME — an
   * operator cannot check "10008" against anything they know.
   */
  readonly matchValueOptions?: readonly MatchValueOption[];
}

/**
 * The rule value as the summary should PRINT it. A LABEL is a free string the
 * operator invented, so it gets no English aside — `hata (Bug)` would be a
 * confident wrong answer on the one screen whose job is letting somebody
 * check what they are about to create. A stored id is shown by its name.
 */
function matchValueOf(
  draft: { matchKind: string; matchValue: string },
  options: readonly MatchValueOption[] = [],
): string {
  const value = displayMatchValue(draft.matchValue.trim(), options);
  return draft.matchKind === "label" ? value : matchValueLabel(value);
}

export function ReviewPane({ draft, alreadyBound, intakeAppliesLive, matchValueOptions }: ReviewPaneProps): ReactNode {
  const t = useT();
  // The wire body, verbatim — the summary signs off on what will be SENT.
  const statusMap = buildStatusMap(draft.statusOn, draft.statusDraft, draft.reassignOnNeedInfo, draft.flowType);
  const mappedPoints = STATUS_POINTS.filter(
    (point) => typeof statusMap?.[point] === "string" && statusMap[point] !== "",
  );
  const mirror = gateMirror(statusMap);
  const flowName = t(`setup.flow.name.${draft.flowType}`);

  return (
    <>
      <p className="scr-prose">{t("setup.review.intro")}</p>

      {/* 1 — the listening rule, in one sentence an operator can check. */}
      <h4 className="scr-h">{t("setup.review.rule_heading")}</h4>
      <p className="scr-prose">
        {draft.matchKind === "assigned"
          ? t("setup.review.rule_sentence_assigned", { project: draft.jiraProject, flow: flowName })
          : t("setup.review.rule_sentence", {
              project: draft.jiraProject,
              kind: t(`setup.tickets.kind.${draft.matchKind}`),
              value: matchValueOf(draft, matchValueOptions),
              flow: flowName,
            })}
      </p>
      <ul className="scr-list">
        <li>
          {draft.allowedStatuses.length === 0
            ? t("setup.review.allowed_statuses_none")
            : t("setup.review.allowed_statuses", { statuses: draft.allowedStatuses.join(", ") })}
        </li>
        <li>
          {/*
            Özet, GÖNDERİLENİ imzalar. Bir dönem burası ölü `gatesCustom`
            alanını okuyordu ve radyoda "Yok" seçen operatöre "risk seviyesine
            göre" yazıyordu — tel ise her zaman `{steps}` gönderiyordu.
          */}
          {t(`setup.gates.choice.${draft.gateChoice}`)}
        </li>
      </ul>

      {/* 2 — what the ticket does on the board: two mutually exclusive answers,
          and the comment-only one stated outright. */}
      <h4 className="scr-h">{t("setup.review.status_heading")}</h4>
      {mappedPoints.length === 0 && statusMap?.reassignOnNeedInfo !== true ? (
        <p className="scr-prose">{t("setup.review.status_comment_only")}</p>
      ) : (
        <>
          <ul className="scr-list">
            {mappedPoints.map((point) => (
              <li key={point}>
                {t(`setup.status.point.${point}`)}: <b>{statusMap?.[point]}</b>
              </li>
            ))}
            {statusMap?.reassignOnNeedInfo === true && <li>{t("setup.status.reassign")}</li>}
          </ul>
          <p className="scr-hint">{t("setup.review.status_note")}</p>
        </>
      )}

      {/* 2b — the gate, read from the same wire body. Its empty state is
          spelled out with the fields that would fill it: silence here came
          back from the field as "neden çalışmıyor". */}
      <h4 className="scr-h">{t("setup.review.gate_status_heading")}</h4>
      {mirror.approve === null && mirror.return === null ? (
        <p className="scr-prose">{t("setup.review.gate_status_none")}</p>
      ) : (
        <ul className="scr-list">
          {mirror.approve !== null && (
            <li>
              {t("setup.review.gate_status_approve", { status: mirror.approve })}{" "}
              {mirror.approveFrom === null ? "" : t(`listening.gate_status.from.${mirror.approveFrom}`)}
            </li>
          )}
          {mirror.return !== null && (
            <li>
              {t("setup.review.gate_status_return", { status: mirror.return })}{" "}
              {mirror.returnFrom === null ? "" : t(`listening.gate_status.from.${mirror.returnFrom}`)}
            </li>
          )}
        </ul>
      )}

      {/* 3 — how an approval given on the ticket reaches Maestro. */}
      <h4 className="scr-h">{t("setup.review.intake_heading")}</h4>
      <p className="scr-prose">{t(`setup.review.intake_sentence.${draft.commandIntake}`)}</p>
      {intakePolls(draft.commandIntake) && (
        <p className="scr-hint">{t("setup.review.intake_seconds", { seconds: String(draft.pollSeconds) })}</p>
      )}
      <p className="scr-hint">
        {intakeAppliesLive === undefined
          ? t("setup.intake.applies_unknown")
          : intakeAppliesLive
            ? t("setup.intake.applies_live")
            : t("setup.intake.applies_restart")}
      </p>

      {/* 4 — the binding: repo, build profile, and the derived answers. Three
          mutually exclusive sentences: no repository at all (ticket text only),
          a repository the analysis READS, a repository the code lands in. */}
      <h4 className="scr-h">{t("setup.review.binding_heading")}</h4>
      {alreadyBound ? (
        <p className="scr-prose">{t("setup.review.binding_exists", { project: draft.jiraProject })}</p>
      ) : (
        <>
          <p className="scr-prose">
            {bindsNoRepository(draft)
              ? t("setup.review.binding_sentence_norepo", { project: draft.jiraProject })
              : flowNeedsRepository(draft.flowType)
                ? t("setup.review.binding_sentence", {
                    project: draft.jiraProject,
                    repo: draft.repoFullName,
                    platform: t(`platform.${draft.platform}`),
                  })
                : t("setup.review.binding_sentence_analiz_repo", {
                    project: draft.jiraProject,
                    repo: draft.repoFullName,
                  })}
          </p>
          <ul className="scr-list">
            <li>{t("setup.review.trigger.by_rule")}</li>
            {/* Nothing is merged on an analysis-only flow; on a code flow the
                merger is decided by the rule's work mode, not by this wizard. */}
            {flowNeedsRepository(draft.flowType) && <li>{t("setup.review.merge.human")}</li>}
            <li>{t(`setup.review.dataclass.${draft.dataClass}`)}</li>
          </ul>
          {/* What happens to the binding on save, stated BEFORE the button:
              the wizard tries the approval itself; four-eyes may still apply. */}
          <div className="scr-note scr-mt-2">{t("setup.review.four_eyes")}</div>
        </>
      )}
    </>
  );
}

/**
 * How the binding ended up once the writes went through.
 *
 *  · `bound`          — the proposal was filed AND approved on the spot
 *  · `awaiting`       — filed; the BFF answered `self_approval`, a second admin approves
 *  · `approve_failed` — filed; the approval failed for another reason (named)
 *  · `already_bound`  — no proposal: the project was live before the wizard ran
 */
export type SetupOutcome =
  | { readonly outcome: "bound" | "awaiting" | "already_bound" }
  | { readonly outcome: "approve_failed"; readonly errorKey: string };

/**
 * What to do once the writes have gone through — rendered in place of the
 * form after a successful save: the concrete next actions, not a green toast.
 */
export interface DonePaneProps {
  readonly draft: SetupDraft;
  readonly result: SetupOutcome;
  readonly matchValueOptions?: readonly MatchValueOption[];
  readonly onAgain: () => void;
}

export function DonePane({ draft, result, matchValueOptions, onAgain }: DonePaneProps): ReactNode {
  const t = useT();
  // The queue is only worth a link while something is actually sitting in it.
  const queueOpen = result.outcome === "awaiting" || result.outcome === "approve_failed";
  return (
    <Card title={t("setup.done.title")} subtitle={t("setup.done.sub")}>
      <p className="scr-prose">{t("setup.done.rule_created")}</p>
      {result.outcome === "bound" && <div className="scr-note scr-hint--ok">{t("setup.done.bound")}</div>}
      {result.outcome === "awaiting" && (
        <div className="scr-note scr-note--warn">
          {t("setup.done.awaiting_approval")}{" "}
          <ButtonLink size="sm" to="/projects?tab=routing">
            {t("setup.done.open_approval")}
          </ButtonLink>
        </div>
      )}
      {result.outcome === "approve_failed" && (
        <div className="scr-note scr-note--danger">
          {t("setup.done.approve_failed", { error: t(result.errorKey) })}{" "}
          <ButtonLink size="sm" to="/projects?tab=routing">
            {t("setup.done.open_approval")}
          </ButtonLink>
        </div>
      )}
      <h4 className="scr-h">{t("setup.done.next_heading")}</h4>
      <ol className="scr-list">
        <li>
          {draft.matchKind === "assigned"
            ? t("setup.done.next_open_ticket_assigned", { project: draft.jiraProject })
            : t("setup.done.next_open_ticket", {
                project: draft.jiraProject,
                kind: t(`setup.tickets.kind.${draft.matchKind}`),
                value: matchValueOf(draft, matchValueOptions),
              })}
        </li>
        <li>{t("setup.done.next_assign")}</li>
        <li>
          {/* The Panel is where a run shows up; "Canlı akış" was a screen the
              menu does not have. */}
          {t("setup.done.next_watch")}{" "}
          <ButtonLink size="sm" to="/dash">
            {t("setup.done.open_dash")}
          </ButtonLink>
        </li>
        <li>{t(`setup.done.next_approve.${draft.commandIntake}`)}</li>
      </ol>
      <div className="scr-actions">
        <ButtonLink to={queueOpen ? "/projects?tab=routing" : "/projects?tab=listening"}>
          {t(queueOpen ? "setup.done.open_approval" : "setup.done.open_expert")}
        </ButtonLink>
        <Button onClick={onAgain}>{t("setup.done.again")}</Button>
      </div>
    </Card>
  );
}
