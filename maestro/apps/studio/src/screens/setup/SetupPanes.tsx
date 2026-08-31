import type { ReactNode } from "react";
import { useT } from "../../i18n/I18nProvider.tsx";
import { Card, Input, Select } from "../../ui/index.ts";
import { englishAside, matchValueLabel } from "../common/jira-english.ts";
import { STATUS_POINTS, firesFor, type StatusPoint } from "../common/status-map.ts";
import {
  COMMAND_INTAKES,
  DATA_CLASSES,
  FLOW_TYPES,
  MAX_POLL_SECONDS,
  MIN_POLL_SECONDS,
  flowUnavailableReason,
  intakePolls,
  intakeUnavailableReason,
  type DataClass,
  type FlowType,
  type MatchKind,
  type SetupDraft,
} from "./model.ts";

/**
 * The wizard's panes. Presentational on purpose: every one of them takes the
 * single draft plus an `onChange`, so navigating between steps is a state
 * change in the container and never an unmount that could drop what was typed.
 *
 * The register throughout is the one the whole wizard is for: a sentence about
 * what will HAPPEN, not the name of the field that causes it. "risk_tiered"
 * appears nowhere; "Maestro talebi inceleyip analiz belgesi hazırlasın" does.
 */

/** What each pane needs beyond the draft, gathered by the container. */
export interface PaneData {
  /** Jira connections, and the projects of the chosen one. */
  readonly jiraConnections: readonly { id: string; label: string }[];
  readonly jiraProjects: readonly { key: string; name: string }[];
  readonly jiraProjectsLoading: boolean;
  readonly jiraProjectsError: string | null;
  /** SCM connections, and the repos of the chosen one. */
  readonly scmConnections: readonly { id: string; label: string }[];
  /**
   * How many repository connections exist, or `null` while that is still
   * unknown (the request is in flight, or it failed).
   *
   * Separate from `scmConnections.length` because an empty array and an
   * unanswered question look identical there, and step 1 has to tell them
   * apart: "you have no repository connection" is a claim about the install,
   * and making it while a request is still running sends an operator to
   * Ayarlar to fix something that was never broken.
   */
  readonly scmConnectionCount: number | null;
  readonly scmRepos: readonly string[];
  readonly scmReposLoading: boolean;
  readonly scmReposError: string | null;
  readonly platforms: readonly string[];
  /** Live Jira values for the chosen project + match kind; empty → free text. */
  readonly matchValues: readonly string[];
  /**
   * Set when `matchValues` came from the FALLBACK source, whose issue-type
   * names can be a different localisation from the ones on the tickets. The
   * dropdown still shows — a list beats a blank box — but it says so.
   */
  readonly matchValuesNote: string | null;
  /** Live Jira STATUS names, for the status map; empty → free text. */
  readonly statusNames: readonly string[];
  /** True once a connection has reported a bot account id (step 3's pre-fill). */
  readonly botKnown: boolean;
  /**
   * Whether the configured work driver can read a ticket's comment thread —
   * `undefined` while that is still unknown (the request is in flight, or the
   * endpoint is not there).
   *
   * The wizard's answer to the worst outcome available here: an operator picks
   * "biz Jira'ya soralım", the wizard saves it, and nothing ever polls because
   * the driver has no `listComments`. Mirrors the BFF's own `canReadComments`
   * check rather than a guess from the connection's `kind` — which driver
   * offers what has changed once already, and a screen that hardcodes the
   * answer goes stale silently.
   */
  readonly canReadComments: boolean | undefined;
  /**
   * Whether the poller can be started/stopped WITHOUT restarting the service,
   * as the platform itself reports it. `undefined` while unknown.
   *
   * Decides which of two sentences the pane shows, and they are not
   * interchangeable: "hemen devreye girer" on a deployment that needs a restart
   * is exactly the silent wait this step exists to end.
   */
  readonly intakeAppliesLive: boolean | undefined;
}

export interface PaneProps {
  readonly draft: SetupDraft;
  readonly data: PaneData;
  readonly onChange: (patch: Partial<SetupDraft>) => void;
}

/**
 * Step 1 — "Ne yapmak istiyorsun?".
 *
 * A radio list, not a dropdown. The three flows differ in what Maestro is
 * ALLOWED to do (write code or not, merge or not), and a collapsed select shows
 * one option at a time — an operator would pick the first one without ever
 * reading that the other two open pull requests. Each option carries its
 * outcome sentence beside the label so the difference is visible before the
 * click, not after.
 */
export function FlowPane({ draft, data, onChange }: PaneProps): ReactNode {
  const t = useT();
  return (
    <Card title={t("setup.flow.title")} subtitle={t("setup.flow.sub")}>
      <p className="scr-prose">{t("setup.flow.intro")}</p>
      <div className="setup-choices" role="radiogroup" aria-label={t("setup.flow.title")}>
        {FLOW_TYPES.map((flow) => {
          /**
           * Why this flow cannot be run here, if it cannot.
           *
           * The option is still SHOWN and still selectable. Hiding it would
           * answer "why can't Maestro fix bugs?" with silence, and a disabled
           * radio with no explanation is the same silence with a grey tint.
           * What it gains instead is a sentence naming the missing piece and a
           * link to where it is added — the same treatment a missing Jira
           * connection already gets — and "İleri" stops until it is resolved.
           */
          const blocked = flowUnavailableReason(flow, data.scmConnectionCount);
          return (
            <label
              key={flow}
              className={
                "setup-choice" +
                (draft.flowType === flow ? " setup-choice--on" : "") +
                (blocked === null ? "" : " setup-choice--blocked")
              }
            >
              <input
                type="radio"
                name="setup-flow"
                value={flow}
                checked={draft.flowType === flow}
                onChange={() => onChange({ flowType: flow as FlowType })}
              />
              <span className="setup-choice__body">
                <span className="setup-choice__label">{t(`setup.flow.name.${flow}`)}</span>
                <span className="setup-choice__desc">{t(`setup.flow.desc.${flow}`)}</span>
                {/* What the choice COSTS, spelled out: which gates run, whether a
                    repository is touched. An operator picking "geliştirme" should
                    learn here that it opens pull requests, not from the summary. */}
                <span className="setup-choice__meta">{t(`setup.flow.meta.${flow}`)}</span>
                {blocked !== null && (
                  <span className="scr-note scr-note--warn setup-choice__blocked">
                    {t(blocked)}
                  </span>
                )}
              </span>
            </label>
          );
        })}
      </div>
    </Card>
  );
}

/**
 * Step 2 — the Jira project and the repository the work lands in.
 *
 * Same four selects as the expert onboarding form, fed by the same endpoints,
 * but WITHOUT the trigger/gate/merge trio: those three are derived from step 1
 * and shown back as sentences on the summary. Asking a first-time operator to
 * choose a gate set is the thing this wizard exists not to do.
 */
export function ProjectPane({ draft, data, onChange }: PaneProps): ReactNode {
  const t = useT();

  // The two live lists each have four faces an operator has to tell apart: no
  // connection picked yet, loading, a provider error, and an empty result. A
  // single "seçiniz" for all four is how "hiçbir şey çıkmıyor" tickets happen.
  const projectPlaceholder =
    draft.jiraConnectionId === ""
      ? t("setup.project.pick_jira_conn_first")
      : data.jiraProjectsLoading
        ? t("setup.common.loading")
        : data.jiraProjectsError !== null
          ? data.jiraProjectsError
          : data.jiraProjects.length === 0
            ? t("setup.project.no_projects")
            : t("setup.common.choose");

  const repoPlaceholder =
    draft.connectionId === ""
      ? t("setup.project.pick_scm_conn_first")
      : data.scmReposLoading
        ? t("setup.common.loading")
        : data.scmReposError !== null
          ? data.scmReposError
          : data.scmRepos.length === 0
            ? t("setup.project.no_repos")
            : t("setup.common.choose");

  return (
    <Card title={t("setup.project.title")} subtitle={t("setup.project.sub")}>
      <p className="scr-prose">{t("setup.project.intro")}</p>
      <div className="scr-grid scr-grid--2">
        <Select
          label={t("setup.project.jira_connection")}
          value={draft.jiraConnectionId}
          onChange={(e) => onChange({ jiraConnectionId: e.target.value, jiraProject: "" })}
          options={[
            { value: "", label: t("setup.common.choose") },
            ...data.jiraConnections.map((c) => ({ value: c.id, label: c.label })),
          ]}
          hint={t("setup.project.jira_connection_hint")}
        />
        <Select
          label={t("setup.project.jira_project")}
          value={draft.jiraProject}
          onChange={(e) => onChange({ jiraProject: e.target.value, matchValue: "" })}
          disabled={
            draft.jiraConnectionId === "" ||
            data.jiraProjectsLoading ||
            data.jiraProjects.length === 0
          }
          options={[
            { value: "", label: projectPlaceholder },
            ...data.jiraProjects.map((p) => ({ value: p.key, label: `${p.key} · ${p.name}` })),
          ]}
          hint={t("setup.project.jira_project_hint")}
        />
      </div>
      {/* For `analiz` the repository is an OFFER, not a requirement: the
          analysis is written from the ticket text, and a repo only enriches
          the impact section. The note stands ABOVE the selects so the operator
          reads "isteğe bağlı" before wondering why an empty field lets them
          through — and before going off to request a GitHub token their team
          does not need. */}
      {draft.flowType === "analiz" && (
        <div className="scr-note" style={{ marginTop: 12 }}>
          {t("setup.project.repo_optional_analiz")}
        </div>
      )}
      <div className="scr-grid scr-grid--2" style={{ marginTop: 12 }}>
        <Select
          label={t("setup.project.scm_connection")}
          value={draft.connectionId}
          onChange={(e) => onChange({ connectionId: e.target.value, repoFullName: "" })}
          options={[
            { value: "", label: t("setup.common.choose") },
            ...data.scmConnections.map((c) => ({ value: c.id, label: c.label })),
          ]}
          hint={t("setup.project.scm_connection_hint")}
        />
        <Select
          label={t("setup.project.scm_repo")}
          value={draft.repoFullName}
          onChange={(e) => onChange({ repoFullName: e.target.value })}
          disabled={
            draft.connectionId === "" || data.scmReposLoading || data.scmRepos.length === 0
          }
          options={[
            { value: "", label: repoPlaceholder },
            ...data.scmRepos.map((r) => ({ value: r, label: r })),
          ]}
        />
      </div>
      <div className="scr-grid scr-grid--2" style={{ marginTop: 12 }}>
        <Select
          label={t("setup.project.platform")}
          value={draft.platform}
          onChange={(e) => onChange({ platform: e.target.value })}
          options={[
            { value: "", label: t("setup.common.choose") },
            ...data.platforms.map((p) => ({ value: p, label: t(`platform.${p}`) })),
          ]}
          hint={t("setup.project.platform_hint")}
        />
      </div>
      {/* The data class (M18). A radio list for the same reason step 1 is one:
          the three answers differ in what Maestro is ALLOWED to do with the
          ticket's content, and a collapsed select shows one at a time — the
          operator would take the first without ever reading that the third
          turns the analysis off on an install with no on-prem model. Each
          option carries its CONSEQUENCE, not its policy name. */}
      <h4 className="setup-review__h" style={{ marginTop: 18 }}>
        {t("setup.dataclass.heading")}
      </h4>
      <p className="scr-prose">{t("setup.dataclass.intro")}</p>
      <div className="setup-choices" role="radiogroup" aria-label={t("setup.dataclass.heading")}>
        {DATA_CLASSES.map((cls) => (
          <label
            key={cls}
            className={"setup-choice" + (draft.dataClass === cls ? " setup-choice--on" : "")}
          >
            <input
              type="radio"
              name="setup-dataclass"
              value={cls}
              checked={draft.dataClass === cls}
              onChange={() => onChange({ dataClass: cls as DataClass })}
            />
            <span className="setup-choice__body">
              <span className="setup-choice__label">{t(`setup.dataclass.name.${cls}`)}</span>
              <span className="setup-choice__desc">{t(`setup.dataclass.desc.${cls}`)}</span>
              <span className="setup-choice__meta">{t(`setup.dataclass.meta.${cls}`)}</span>
            </span>
          </label>
        ))}
      </div>
      {/* `gizli` is the answer that can stop the product working, so its warning
          is not a hint under a field — it is a block the operator cannot scroll
          past, shown only when they have actually chosen it. This is the exact
          gap that left SAM1-12 stalled with "modeli kullanamadım" and nothing
          on any screen connecting that message to the data class. */}
      {draft.dataClass === "gizli" && (
        <div className="scr-note scr-note--warn" style={{ marginTop: 10 }}>
          {t("setup.dataclass.gizli_warning")}
        </div>
      )}

      <div className="scr-note" style={{ marginTop: 12 }}>
        {t("setup.project.four_eyes_note")}
      </div>
    </Card>
  );
}

/**
 * Step 3 — which tickets Maestro picks up.
 *
 * Two questions: whose queue (the bot account) and which tickets in it. The
 * value list is read LIVE off the project so "Hata" is picked rather than
 * spelled; when Jira cannot be read the field falls back to free text rather
 * than to an empty dropdown that would make the step impossible to finish.
 */
export function TicketsPane({ draft, data, onChange }: PaneProps): ReactNode {
  const t = useT();
  // "Bota atanan her ticket" has no second question, so the value field is not
  // merely disabled — it is GONE. A greyed-out box the operator cannot fill
  // reads as an unfinished form; an absent one reads as an answered question.
  const anyAssigned = draft.matchKind === "assigned";
  return (
    <Card title={t("setup.tickets.title")} subtitle={t("setup.tickets.sub")}>
      <p className="scr-prose">{t("setup.tickets.intro")}</p>
      <div className="scr-grid scr-grid--2">
        <Select
          label={t("setup.tickets.match_kind")}
          value={draft.matchKind}
          onChange={(e) =>
            // Switching the question invalidates the answer: an issue-type name
            // is not a status name, and keeping it would silently save a rule
            // that can never match a ticket. Switching TO `assigned` clears it
            // for the same reason from the other side — the value is not part
            // of that rule, and a leftover "Hata" riding along in the draft
            // would show up in the summary as a condition nobody set.
            onChange({ matchKind: e.target.value as MatchKind, matchValue: "" })
          }
          options={[
            { value: "issuetype", label: t("setup.tickets.kind.issuetype") },
            { value: "status", label: t("setup.tickets.kind.status") },
            { value: "assigned", label: t("setup.tickets.kind.assigned") },
          ]}
          hint={t(`setup.tickets.kind_hint.${draft.matchKind}`)}
        />
        {anyAssigned ? null : data.matchValues.length > 0 ? (
          <Select
            label={t("setup.tickets.match_value")}
            value={draft.matchValue}
            // The option's VALUE is the localised name Jira serves and the rule
            // stores; only its LABEL carries the English aside. A dropdown that
            // sent "Görev (Task)" would write a matchValue no ticket can equal.
            onChange={(e) => onChange({ matchValue: e.target.value })}
            options={[
              { value: "", label: t("setup.common.choose") },
              ...data.matchValues.map((v) => ({ value: v, label: matchValueLabel(v) })),
            ]}
            hint={data.matchValuesNote ?? t("setup.tickets.match_value_hint_live")}
          />
        ) : (
          <Input
            label={t("setup.tickets.match_value")}
            value={draft.matchValue}
            onChange={(e) => onChange({ matchValue: e.target.value })}
            // Typed by hand, so the English name cannot be offered up front —
            // but once what they typed IS a name we know, saying so confirms
            // they hit the right one.
            hint={
              englishAside(draft.matchValue) === null
                ? t("setup.tickets.match_value_hint_manual")
                : t("setup.tickets.match_value_hint_english", {
                    english: englishAside(draft.matchValue) ?? "",
                  })
            }
          />
        )}
      </div>
      {anyAssigned && (
        <div className="scr-note" style={{ marginTop: 12 }}>
          {t("setup.tickets.assigned_note")}
        </div>
      )}
      <div style={{ marginTop: 12 }}>
        <Input
          label={t("setup.tickets.assignee")}
          value={draft.assigneeAccountId}
          onChange={(e) => onChange({ assigneeAccountId: e.target.value })}
          placeholder="712020:…"
          hint={
            data.botKnown ? t("setup.tickets.assignee_hint_auto") : t("setup.tickets.assignee_hint")
          }
        />
      </div>
      <div className="scr-note" style={{ marginTop: 12 }}>
        {t("setup.tickets.note")}
      </div>
    </Card>
  );
}

/**
 * Step 4 — the Jira status map, OFF by default.
 *
 * The one step that is genuinely optional, and it says so in its own heading.
 * Off means comment-only, which is what every rule in the platform does today;
 * a wizard that started moving a bank's tickets because the operator clicked
 * "İleri" five times would be a defect, not a convenience.
 */
export function StatusPane({ draft, data, onChange }: PaneProps): ReactNode {
  const t = useT();
  const setPoint = (point: StatusPoint, value: string): void =>
    onChange({ statusDraft: { ...draft.statusDraft, [point]: value } });

  // Which of the five points the chosen flow can actually reach. `duzeltme`
  // skips the analysis gate entirely (see `firesFor`), so its two approval
  // moments are DEAD: a value mapped there would never move a ticket. The dead
  // fields stay visible but disabled, with the reason as their hint — an
  // operator who saw five points on an analiz rule must be able to see WHY this
  // rule has three, not wonder where two went.
  const livePoints = new Set(firesFor(draft.flowType));

  return (
    <Card title={t("setup.status.title")} subtitle={t("setup.status.sub")}>
      <p className="scr-prose">{t("setup.status.intro")}</p>
      <label className="scr-check" style={{ marginTop: 4 }}>
        <input
          type="checkbox"
          checked={draft.statusOn}
          // Turning it off never rewrites the draft — an operator who unticks it
          // to re-read the explanation and ticks it again gets their five values
          // back. Only what the summary builds depends on the flag.
          onChange={(e) => onChange({ statusOn: e.target.checked })}
        />
        {t("setup.status.enable")}
      </label>

      {draft.statusOn && (
        <>
          <p className="scr-note" style={{ marginTop: 12 }}>
            {t("setup.status.exact")}
          </p>
          <div className="scr-grid scr-grid--2" style={{ marginTop: 8 }}>
            {STATUS_POINTS.map((point) => {
              // A dead point is disabled, never hidden, and its hint is the
              // REASON rather than the usual "what this moment means" — the
              // honest answer to "neden seçemiyorum?" is a sentence, not a
              // missing field. A value the draft still holds there (typed under
              // another flow) stays visible; `buildStatusMap` keeps it off the
              // wire and the summary never lists it.
              const dead = !livePoints.has(point);
              const hint = dead ? t("setup.status.dead_hint") : t(`setup.status.hint.${point}`);
              return data.statusNames.length > 0 ? (
                <Select
                  key={point}
                  label={t(`setup.status.point.${point}`)}
                  value={draft.statusDraft[point]}
                  onChange={(e) => setPoint(point, e.target.value)}
                  disabled={dead}
                  options={[
                    { value: "", label: t("setup.status.skip") },
                    ...data.statusNames.map((v) => ({ value: v, label: v })),
                  ]}
                  hint={hint}
                />
              ) : (
                // Jira's status list could not be read. Free text rather than an
                // empty dropdown, so the step can still be completed — the
                // "birebir aynı yazın" warning above is what carries the risk.
                <Input
                  key={point}
                  label={t(`setup.status.point.${point}`)}
                  value={draft.statusDraft[point]}
                  onChange={(e) => setPoint(point, e.target.value)}
                  disabled={dead}
                  hint={hint}
                />
              );
            })}
          </div>
          <label className="scr-check" style={{ marginTop: 12 }}>
            <input
              type="checkbox"
              checked={draft.reassignOnNeedInfo}
              onChange={(e) => onChange({ reassignOnNeedInfo: e.target.checked })}
            />
            {t("setup.status.reassign")}
          </label>
          <p className="scr-note" style={{ marginTop: 6 }}>
            {t("setup.status.reassign_hint")}
          </p>
        </>
      )}
    </Card>
  );
}

/**
 * Step 5 — "Onaylar Maestro'ya nasıl ulaşsın?".
 *
 * The step this wizard was missing, and the failure it closes is the most
 * expensive one on the platform: `/approve` written on a ticket is the
 * documented way to pass a gate, and whether it is ever READ depended on
 * `JIRA_POLL_MS` — an environment variable in a file on the server, which a
 * bank operator cannot edit and cannot be expected to have heard of. So a run
 * would reach an approval gate, a human would approve it in the only place they
 * were told to, and the gate would wait forever with nothing anywhere saying
 * why.
 *
 * Asked as ONE question with three answers rather than two switches, because
 * webhook and polling are alternatives: they read the same comments, and an
 * operator who understood them as independent options would turn both on
 * without meaning to pay for both.
 *
 * Its own step rather than a field on step 2 for a reason the pane states out
 * loud: this is the one PLATFORM-WIDE answer in a per-project wizard. Buried in
 * "hangi proje, hangi uygulama?" it would read as a property of that project,
 * and the second run of the wizard would silently change the first project's
 * behaviour.
 */
export function IntakePane({ draft, data, onChange }: PaneProps): ReactNode {
  const t = useT();
  const polls = intakePolls(draft.commandIntake);

  return (
    <Card title={t("setup.intake.title")} subtitle={t("setup.intake.sub")}>
      <p className="scr-prose">{t("setup.intake.intro")}</p>

      <div className="setup-choices" role="radiogroup" aria-label={t("setup.intake.title")}>
        {COMMAND_INTAKES.map((intake) => {
          /**
           * Why this answer cannot be given on this install, if it cannot.
           *
           * Shown, selectable and explained — never hidden. The two polling
           * answers are unavailable on a driver with no comment reader, and an
           * operator whose webhook cannot arrive is precisely the person who
           * came here to pick one: silence would leave them clicking "İleri"
           * on a setting that does nothing.
           */
          const blocked = intakeUnavailableReason(intake, data.canReadComments);
          return (
            <label
              key={intake}
              className={
                "setup-choice" +
                (draft.commandIntake === intake ? " setup-choice--on" : "") +
                (blocked === null ? "" : " setup-choice--blocked")
              }
            >
              <input
                type="radio"
                name="setup-intake"
                value={intake}
                checked={draft.commandIntake === intake}
                onChange={() => onChange({ commandIntake: intake })}
              />
              <span className="setup-choice__body">
                <span className="setup-choice__label">{t(`setup.intake.name.${intake}`)}</span>
                <span className="setup-choice__desc">{t(`setup.intake.desc.${intake}`)}</span>
                {/* What the answer COSTS. The two polling answers put load on
                    the bank's Jira, every interval, forever — an operator
                    should read that before the click, not discover it from a
                    Jira administrator afterwards. */}
                <span className="setup-choice__meta">{t(`setup.intake.meta.${intake}`)}</span>
                {blocked !== null && (
                  <span className="scr-note scr-note--warn">{t(blocked)}</span>
                )}
              </span>
            </label>
          );
        })}
      </div>

      {/* The interval, asked only when it will be used. A webhook-only install
          has no interval to argue about, and a field that does nothing is a
          field that teaches the operator to ignore this screen. */}
      {polls && (
        <div style={{ marginTop: 12 }}>
          <Input
            label={t("setup.intake.seconds")}
            type="number"
            min={MIN_POLL_SECONDS}
            max={MAX_POLL_SECONDS}
            value={String(draft.pollSeconds)}
            // An empty field parses to NaN rather than 0: 0 is a MEANING here
            // ("off") and typing over the value must not pass through it. NaN
            // is what `stepBlockedReason` refuses with the range sentence.
            onChange={(e) => onChange({ pollSeconds: Number.parseInt(e.target.value, 10) })}
            hint={t("setup.intake.seconds_hint", {
              min: String(MIN_POLL_SECONDS),
              max: String(MAX_POLL_SECONDS),
            })}
          />
          <div className="scr-note scr-note--warn" style={{ marginTop: 8 }}>
            {t("setup.intake.load_warning")}
          </div>
        </div>
      )}

      {/* "İkisi birden" — the duplicate-processing question, answered before it
          is asked. Two paths reading the same comments IS a real risk, and the
          operator is entitled to know which mechanism stops it rather than
          being told to trust the platform. */}
      {draft.commandIntake === "both" && (
        <div className="scr-note" style={{ marginTop: 12 }}>
          {t("setup.intake.double_guard")}
        </div>
      )}

      {/* WHEN the answer takes effect. Read from the platform rather than
          assumed: promising "hemen geçerli" on a deployment that needs a
          restart would leave the operator waiting on a gate that is never
          polled — the same silent wait this step exists to end. */}
      <p className="scr-note" style={{ marginTop: 12 }}>
        {data.intakeAppliesLive === undefined
          ? t("setup.intake.applies_unknown")
          : data.intakeAppliesLive
            ? t("setup.intake.applies_live")
            : t("setup.intake.applies_restart")}
      </p>

      {/* This one answer is not about the project the operator just configured. */}
      <div className="scr-note scr-note--warn" style={{ marginTop: 12 }}>
        {t("setup.intake.global_note")}
      </div>
    </Card>
  );
}
