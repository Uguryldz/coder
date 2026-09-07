import { useState } from "react";
import type { ReactNode } from "react";
import { STEP_IDS, type WorkflowRunState } from "@maestro/contracts";
import { useI18n, useT } from "../../i18n/I18nProvider.tsx";
import { dateTimeLabel } from "../shared/format.ts";
import type { RunFailure } from "./run-state.ts";

/**
 * The nineteen delivery steps, with the run's position marked — and, under a
 * step that said something went wrong, WHAT it said.
 *
 * The order and the ids come from `STEP_IDS` in packages/contracts — this list
 * is not allowed to keep its own copy, because a screen that drifts from the
 * workflow's step table shows a person the wrong stage of their own work.
 *
 * The error notes come from `recentErrors` on the detail body: the activity's
 * own journal lines ("model çıktısı şemayı tutturamadı", "insana devredildi",
 * …), each hung under the step that was current when it was written. This
 * list used to say "hata — düzeltiliyor" beside a step and nothing else, which
 * left the operator to open the journal and guess which of forty lines was
 * the reason. The text is shown IN FULL — a schema error is four hundred
 * characters of what the model got wrong, and every one of them is a clue —
 * behind a "tamamını göster" fold when it is long.
 */
export function StepList({
  run,
  errors = [],
}: {
  readonly run: WorkflowRunState;
  /** Newest first, as the BFF sends them. */
  readonly errors?: readonly RunFailure[];
}): ReactNode {
  const t = useT();
  const currentIndex = STEP_IDS.indexOf(run.step);
  // An error line written before the first transition has no step of its own;
  // it belongs under the run's current step, which is the best position the
  // record can vouch for.
  const stepOf = (error: RunFailure): string =>
    error.step !== null && STEP_IDS.includes(error.step) ? error.step : run.step;
  // A run that ended in `fail` with no error line on record: the engine closed
  // it itself (timeout, termination, an activity that died before it could
  // write). Say so under the step rather than showing a bare "hata".
  const failedSilently = run.status === "fail" && errors.length === 0;

  return (
    <div className="scr-steplist">
      {STEP_IDS.map((step, index) => {
        const state = phaseOf(index, currentIndex);
        const notes = errors.filter((error) => stepOf(error) === step);
        return (
          <div key={step} className="scr-steplist__group">
            <div className={`scr-steplist__row scr-steplist__row--${state}`}>
              <span className="scr-steplist__num">{step}</span>
              <span className="scr-steplist__title">{t(`steps.${step}`)}</span>
              <span className="scr-steplist__state">
                {t(stateKey(state, run.status))}
              </span>
            </div>
            {notes.map((error) => (
              <ErrorNote key={error.seq} error={error} />
            ))}
            {failedSilently && step === run.step && (
              <div className="scr-note scr-note--danger" role="note" style={NOTE_STYLE}>
                {t("detail.steps.failure_unknown")}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Indented under the title column of the row above; the grid is 44px + gap. */
const NOTE_STYLE = { margin: "0 0 8px 54px" } as const;

/** Above this many characters the detail folds behind "tamamını göster". */
const FOLD_AT = 280;

function ErrorNote({ error }: { readonly error: RunFailure }): ReactNode {
  const t = useT();
  const { locale } = useI18n();
  const [open, setOpen] = useState(false);
  const long = error.detail.length > FOLD_AT;
  const shown = long && !open ? `${error.detail.slice(0, FOLD_AT)}…` : error.detail;

  return (
    <div
      className="scr-note scr-note--danger"
      role="note"
      aria-label={t("detail.steps.error.label")}
      style={NOTE_STYLE}
    >
      <div className="scr-row">
        <b>{error.title}</b>
        <span className="scr-hint scr-mono">{dateTimeLabel(error.at, locale)}</span>
      </div>
      {error.detail !== "" && (
        // Wrapped, never clipped: the sentence that explains the failure is
        // the one thing on this screen that must not be cut off.
        <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{shown}</div>
      )}
      {long && (
        <button
          type="button"
          className="scr-chip"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {t(open ? "detail.steps.error.show_less" : "detail.steps.error.show_all")}
        </button>
      )}
    </div>
  );
}

type Phase = "done" | "now" | "wait";

function phaseOf(index: number, currentIndex: number): Phase {
  if (currentIndex === -1) return "wait";
  if (index < currentIndex) return "done";
  return index === currentIndex ? "now" : "wait";
}

/**
 * What to say beside a step. Only the CURRENT step reflects run status; a
 * finished step is finished regardless of what happened later.
 */
function stateKey(phase: Phase, status: WorkflowRunState["status"]): string {
  if (phase === "done") return "step.state.done";
  if (phase === "wait") return "step.state.waiting";
  return `step.state.current.${status}`;
}
