import type { ReactNode } from "react";
import { ApiError, messageKeyOf, sweepReasonOf } from "../../api/errors.ts";
import { useT } from "../../i18n/I18nProvider.tsx";
import { Button } from "../../ui/index.ts";
import { ageLabel } from "../shared/format.ts";
import type { SweepRunResult, SweepStatus } from "./types.ts";

/**
 * `95000` → `"1 dk 35 sn"`. Yuvarlama yok: 80 saniyeye ayarlayan operatörün
 * "1 dakika" görmesi, ayarının tutmadığını düşündürür.
 */
export function durationLabel(t: ReturnType<typeof useT>, ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes === 0) return t("listening.sweep.duration_s", { s: String(seconds) });
  if (seconds === 0) return t("listening.sweep.duration_m", { m: String(minutes) });
  return t("listening.sweep.duration_ms", { m: String(minutes), s: String(seconds) });
}

/**
 * Taramanın neden çalışAMAdığı — üç kaynak, öncelik sırasıyla:
 *  1. sunucunun `details.reasonKey`i (katalog anahtarı, kullanıcının dilinde),
 *  2. sunucunun kendi cümlesi (`message`; yalnız `sweep_not_configured` taşır),
 *  3. hata kodunun katalog satırı.
 */
function sweepFailureText(t: ReturnType<typeof useT>, error: unknown): string {
  if (error instanceof ApiError) {
    const key = (error.details as { reasonKey?: unknown } | null | undefined)?.reasonKey;
    if (typeof key === "string" && key.startsWith("listening.")) {
      try {
        return t(key);
      } catch {
        // Bilinmeyen anahtar: aşağıdaki geri düşüşler.
      }
    }
  }
  return sweepReasonOf(error) ?? t(messageKeyOf(error));
}

export interface SweepBannerProps {
  readonly status: SweepStatus | undefined;
  /** `/studio/listening-status` isteğinin hatası — bant bunu SÖYLER, gizlemez. */
  readonly statusError: unknown;
  readonly onRetryStatus: () => void;
  readonly canWrite: boolean;
  readonly run: {
    readonly isPending: boolean;
    readonly isSuccess: boolean;
    readonly isError: boolean;
    readonly data: SweepRunResult | undefined;
    readonly error: unknown;
    readonly mutate: () => void;
  };
}

/**
 * Bir şey ticket ARIYOR mu? Kurallar neyin alınacağını söyler; bu bant birinin
 * bakıp bakmadığını. Üç hâl, üç farklı çare: tarama kapalı, çalışıyor ama
 * bulmuyor, ya da hata veriyor. Dördüncüsü: durumun kendisi okunamadı — o da
 * boş bir alan değil, bir cümledir.
 */
export function SweepBanner({ status, statusError, onRetryStatus, canWrite, run }: SweepBannerProps): ReactNode {
  const t = useT();

  if (status === undefined) {
    if (statusError === undefined || statusError === null) return null;
    return (
      <div className="scr-note scr-note--danger scr-row">
        <span>{t("listening.sweep.status_unavailable")}</span>
        <Button size="sm" onClick={onRetryStatus}>
          {t("action.retry")}
        </Button>
      </div>
    );
  }

  const age = status.lastRunAt === null ? null : ageLabel(status.lastRunAt);
  return (
    <div className={status.enabled ? "scr-note" : "scr-note scr-note--warn"}>
      <div className="scr-row">
        <strong>{status.enabled ? t("listening.sweep.on") : t("listening.sweep.off")}</strong>
        {status.enabled && (
          <span>
            {t("listening.sweep.every", { duration: durationLabel(t, status.intervalMs) })}
            {status.lastRunAt !== null && (
              <>
                {" · "}
                {t("listening.sweep.last", {
                  age: age === null ? "—" : t(age.key, age.params),
                  started: String(status.lastStarted),
                  rules: String(status.rulesSearched),
                })}
              </>
            )}
          </span>
        )}
        {canWrite && (
          <Button size="sm" busy={run.isPending} onClick={run.mutate}>
            {t("listening.sweep.run_now")}
          </Button>
        )}
      </div>
      {status.enabled && (status.lastRestarted ?? 0) > 0 && (
        <div style={{ marginTop: 4 }}>
          {t("listening.sweep.restarted", { count: String(status.lastRestarted ?? 0) })}
        </div>
      )}
      {/* DEVİR — bir ticket üst üste ölüyor ve robot artık denemiyor: bu bir iş. */}
      {status.enabled && (status.lastHandedOver ?? 0) > 0 && (
        <div style={{ marginTop: 4, color: "var(--amber)" }}>
          {t("listening.sweep.handed_over", { count: String(status.lastHandedOver ?? 0) })}
        </div>
      )}
      {status.enabled && status.lastError !== null && (
        <div style={{ marginTop: 4, color: "var(--red)" }}>
          {t("listening.sweep.error")} <span className="scr-mono">{status.lastError}</span>
        </div>
      )}
      {run.isSuccess && run.data !== undefined && (
        <div style={{ marginTop: 4 }}>
          {run.data.error !== undefined ? (
            <span style={{ color: "var(--red)" }}>
              {t("listening.sweep.run_failed")} <span className="scr-mono">{run.data.error}</span>
            </span>
          ) : run.data.started.length === 0 ? (
            t("listening.sweep.run_empty")
          ) : (
            t("listening.sweep.run_took", {
              count: String(run.data.started.length),
              tickets: run.data.started.join(", "),
            })
          )}
        </div>
      )}
      {run.isError && (
        <div style={{ marginTop: 4, color: "var(--red)" }}>{sweepFailureText(t, run.error)}</div>
      )}
    </div>
  );
}
