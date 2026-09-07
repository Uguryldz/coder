import { useState } from "react";
import type { ReactNode } from "react";
import { messageKeyOf } from "../../api/errors.ts";
import { useAuth } from "../../auth/AuthProvider.tsx";
import { useT } from "../../i18n/I18nProvider.tsx";
import { Button, Card, Modal, useToast } from "../../ui/index.ts";
import { useRunRelease, useRunRestart } from "../shared/signals.ts";

export interface RestartPanelProps {
  readonly ticket: string;
  /**
   * Why the panel is shown: the engine forgot the run (`dead`), the run
   * failed / was handed over / was cancelled (`stuck`), or the operator asked
   * for it on a run that is still going (`live` — restart is then "stop and
   * restart"). The wording and the primary action follow.
   */
  readonly reason: "dead" | "stuck" | "live";
}

const RESTART_ROLES = ["admin", "tech-lead"];

/**
 * The operator's three ways out of a run that is not going anywhere:
 *  · Yeniden başlat — retire the run, take the ticket through the flow again NOW;
 *  · Durdur ve yeniden başlat — same, on a run the engine still holds (force);
 *  · Havuza geri ver — retire only; the sweep takes the ticket again from the pool.
 * "Havuzda hiçbir zaman ticket kalamaz" also means: never a dead end on this screen.
 */
export function RestartPanel({ ticket, reason }: RestartPanelProps): ReactNode {
  const t = useT();
  const toast = useToast();
  const { session } = useAuth();
  const restart = useRunRestart();
  const release = useRunRelease();
  const [confirming, setConfirming] = useState<"restart" | "release" | null>(null);
  const allowed = session?.roles.some((role) => RESTART_ROLES.includes(role)) === true;
  const force = reason === "live";

  function submitRestart(): void {
    restart.mutate(force ? { ticket, force: true } : ticket, {
      onSuccess: (result) => {
        setConfirming(null);
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

  function submitRelease(): void {
    release.mutate(ticket, {
      onSuccess: () => {
        setConfirming(null);
        toast.show("success", t("detail.restart.release_done", { ticket }));
      },
      onError: (error) => toast.show("error", t(messageKeyOf(error))),
    });
  }

  return (
    <Card title={t("detail.restart.title")}>
      <p className="scr-hint">{t(reason === "dead" ? "detail.restart.body" : "detail.restart.stuck_body")}</p>
      <div className="scr-actions">
        <Button variant="primary" disabled={!allowed} onClick={() => setConfirming("restart")}>
          {t(force ? "detail.restart.force_action" : "detail.restart.action")}
        </Button>
        <Button disabled={!allowed} onClick={() => setConfirming("release")}>
          {t("detail.restart.release_action")}
        </Button>
      </div>
      <p className="scr-hint">{t("detail.restart.release_hint")}</p>
      {!allowed && <p className="scr-hint">{t("detail.restart.not_allowed")}</p>}
      <Modal
        open={confirming === "restart"}
        onClose={() => setConfirming(null)}
        title={t("detail.restart.confirm_title", { ticket })}
        closeLabel={t("action.close")}
        footer={
          <>
            <Button onClick={() => setConfirming(null)}>{t("action.cancel")}</Button>
            <Button variant="primary" busy={restart.isPending} onClick={submitRestart}>
              {t(force ? "detail.restart.force_action" : "detail.restart.confirm_submit")}
            </Button>
          </>
        }
      >
        <p>{t("detail.restart.confirm_body")}</p>
      </Modal>
      <Modal
        open={confirming === "release"}
        onClose={() => setConfirming(null)}
        title={t("detail.restart.release_confirm", { ticket })}
        closeLabel={t("action.close")}
        footer={
          <>
            <Button onClick={() => setConfirming(null)}>{t("action.cancel")}</Button>
            <Button variant="primary" busy={release.isPending} onClick={submitRelease}>
              {t("detail.restart.release_action")}
            </Button>
          </>
        }
      >
        <p>{t("detail.restart.release_hint")}</p>
      </Modal>
    </Card>
  );
}
