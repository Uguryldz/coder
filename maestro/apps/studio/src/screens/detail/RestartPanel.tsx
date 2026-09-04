import { useState } from "react";
import type { ReactNode } from "react";
import { messageKeyOf } from "../../api/errors.ts";
import { useAuth } from "../../auth/AuthProvider.tsx";
import { useT } from "../../i18n/I18nProvider.tsx";
import { Button, Card, Modal, useToast } from "../../ui/index.ts";
import { useRunRestart } from "../shared/signals.ts";

/**
 * "Koşu motorda bulunamıyor" — ve yanında YAPILACAK ŞEY.
 *
 * ── Neden var ───────────────────────────────────────────────────────────────
 * Bu panel bir teşhis kutusu değil, bir çıkış yolu. Ölçülen durum şuydu:
 * operatörün koşusu motorda yoktu (Temporal'ın saklama süresi 24 saat, ve
 * kapıda bekleyen işler o süreyi aşıyor), panel adımları katalogdan okuyup
 * doğru gösteriyordu, kapıda "onayla/reddet" düğmeleri duruyordu — ve
 * basıldığında "bu ticket için çalışan bir akış yok" cevabı geliyordu.
 *
 * Operatörün elinde hiçbir eylem yoktu: `POST /start` sessizce hiçbir şey
 * yapmıyor (koşu satırının birincil anahtarı motorun iş akışı kimliğiyle aynı,
 * yani yeni koşu eski satıra çarpıp yutuluyordu), tarama da koşusu olan
 * ticket'ı bilerek atlıyordu. Ticket kalıcı olarak akış dışıydı.
 *
 * ── Neden ONAY SORUYOR ──────────────────────────────────────────────────────
 * Yeniden başlatmak eski koşuyu emekliye ayırır. Hiçbir şey silinmez — defter,
 * adımlar ve kanıt paketi olduğu gibi korunur — ama pano değişir ve ticket
 * baştan analiz edilir, yani gerçek bir iş başlar. Kapı kararlarıyla aynı sınıf
 * bir eylem, ve `GatePanel` gibi tek bir kazara tıklamanın ötesinde durmalı.
 *
 * ── Neden ROL KONTROLÜ ──────────────────────────────────────────────────────
 * Rota `RUN_START_ROLES` (admin, tech-lead) istiyor. Düğmeyi gizlemek yerine
 * KISITLAMAK, `GatePanel`in yaptığının aynısı ve aynı sebeple: operatör eylemin
 * var olduğunu görmeli, kendisine ait olmadığını öğrenmeli. Asıl kontrol
 * BFF'te; buradaki yalnız bir kullanılabilirlik işareti.
 */
export interface RestartPanelProps {
  readonly ticket: string;
}

/** Rotanın `requireAnyRole` listesinin aynası — `RUN_START_ROLES`. */
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
        /**
         * KABUL EDİLMEYEN BİR ALIM DA BİR CEVAP — ve sessizce "başarılı"
         * demiyoruz.
         *
         * Eski koşu her hâlükârda emekliye ayrıldı, ama alım reddedilmiş
         * olabilir (kill-switch açık, proje bağlı değil, uygulama eşleşmedi).
         * Bunu bir başarı bildirimiyle geçmek, operatöre olmayan bir koşuyu
         * beklettirirdi — bugün düzeltilen hatanın aynısı, bir yüzey ötede.
         */
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
      <p className="screen-note">{t("detail.restart.body")}</p>
      <div className="screen-actions">
        <Button variant="primary" disabled={!allowed} onClick={() => setConfirming(true)}>
          {t("detail.restart.action")}
        </Button>
      </div>
      {!allowed && <p className="screen-note">{t("gate.not_owner")}</p>}

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
