import { useState } from "react";
import type { ReactNode } from "react";
import { messageKeyOf } from "../../api/errors.ts";
import { useAuth } from "../../auth/AuthProvider.tsx";
import { useT } from "../../i18n/I18nProvider.tsx";
import { Button, Card, Modal, useToast } from "../../ui/index.ts";
import { useRunRestart } from "../shared/signals.ts";

/**
 * "Koşu motorda bulunamıyor" — and the way out.
 *
 * Shown only for a run that is still OPEN (not done/fail/cancelled) but has no
 * execution in the engine: retention expired, or the run died. Its gate
 * buttons would answer "no workflow for this ticket", so instead of a dead
 * control the operator gets the one action that helps — restart, which
 * retires the old run (journal, steps and evidence kept) and takes the ticket
 * through intake again with the listening rule's current settings.
 *
 * Confirms first (a real job starts), and is restricted — not hidden — to the
 * route's roles (`RUN_START_ROLES`: admin, tech-lead), so the operator sees
 * the action exists and learns whose it is. The real check is the BFF's.
 */
export interface RestartPanelProps {
  readonly ticket: string;
}

const RESTART_ROLES = ["admin", "tech-lead"];

export function RestartPanel({ ticket }: RestartPanelProps): ReactNode {
  const t = useT();
  const toast = useToast();
  const { session } = useAuth();
  const restart = useRunRestart();
  const [confirming, setConfirming] = useState(false);

  const allowed = session?.roles.some((role) => RESTART_ROLES.includes(role)) === true;

  function submit(): void {
    restart.mutate(ticket, {
      onSuccess: (result) => {
        setConfirming(false);
        // A refused intake is an answer too: the old run is retired either
        // way, but the ticket may not have been re-admitted (kill-switch,
        // unbound project, no matching application). Never a green toast for that.
        if (result.accepted) {
          toast.show("success", t("detail.restart.done", { ticket }));
        } else {
          toast.show("error", t("detail.restart.refused", { ticket, reason: result.reason ?? "" }));
        }
      },
      onError: (error) => toast.show("error", t(messageKeyOf(error))),
    });
  }

  return (
    <Card title={t("detail.restart.title")}>
      <p className="scr-hint">{t("detail.restart.body")}</p>
      <div className="scr-actions">
        <Button variant="primary" disabled={!allowed} onClick={() => setConfirming(true)}>
          {t("detail.restart.action")}
        </Button>
      </div>
      {!allowed && <p className="scr-hint">{t("detail.restart.not_allowed")}</p>}

      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        title={t("detail.restart.confirm_title", { ticket })}
        closeLabel={t("action.close")}
        footer={
          <>
            <Button onClick={() => setConfirming(false)}>{t("action.cancel")}</Button>
            <Button variant="primary" busy={restart.isPending} onClick={submit}>
              {t("detail.restart.confirm_submit")}
            </Button>
          </>
        }
      >
        <p>{t("detail.restart.confirm_body")}</p>
      </Modal>
    </Card>
  );
}
