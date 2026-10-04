import { useState } from "react";
import { useT } from "../../i18n/I18nProvider.tsx";
import { useApi } from "../../auth/AuthProvider.tsx";

/**
 * "DEPOYU İNDİRMEYİ DENE" — depo eşlemesi satırının kuru provası.
 *
 * Depo eşlemesi sahada üç kez "çalışmıyor" diye bildirildi ve üçünde de arıza
 * eşlemede DEĞİLDİ: bir kez imajda `git` yoktu, bir kez `WORKSPACE_ROOT`
 * tanımsızdı, bir kez jetonun o organizasyona erişimi yoktu. Üçü de aynı tek
 * belirtiyi üretir — analiz kodu görmeden yazılır — ve operatörün elinde bunu
 * ayıracak hiçbir şey yoktu; her seferinde bir koşuyu baştan sona izlemek
 * gerekti.
 *
 * Düğme o üçünü saniyeler içinde ayırır: klonu GERÇEKTEN dener (koşunun
 * kullandığı kodla, jetonla ve ortamla), indiyse kaç dosya hangi commit'ten
 * geldiğini yazar, inmediyse git'in kendi gerekçesini maskelenmiş olarak verir.
 *
 * Koşu açmaz, ajana bir şey göndermez, kredi harcamaz.
 */
interface CloneResult {
  readonly ok: boolean;
  readonly repo: string;
  readonly branch?: string;
  readonly head?: string;
  readonly fileCount?: number;
  readonly durationMs?: number;
  readonly messageKey?: string;
  readonly detail?: string;
}

export function CloneTest(props: { readonly repo: string; readonly branch: string }): React.JSX.Element | null {
  const t = useT();
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CloneResult | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);

  // Depo seçilmemişken düğme yok: denenecek bir şey olmadan "başarısız"
  // göstermek, olmayan bir arızayı aratır.
  if (props.repo.trim() === "") return null;

  const run = async (): Promise<void> => {
    setBusy(true);
    setResult(null);
    setUnavailable(null);
    try {
      const body = await api.post<CloneResult>("/studio/listening-rules/clone-test", {
        repo: props.repo.trim(),
        ...(props.branch.trim() === "" ? {} : { branch: props.branch.trim() }),
      });
      setResult(body);
    } catch (error) {
      /**
       * 503 bir arıza değil, bir CEVAP: bu kurulumda klon kökü tanımlı değil.
       * Onu kırmızı bir hata gibi göstermek operatörü yetki aramaya gönderirdi;
       * oysa düzeltme `.env` dosyasında.
       */
      const key = (error as { body?: { messageKey?: string } }).body?.messageKey;
      setUnavailable(key ?? "listening.repomap.clone_test.unavailable");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: 6 }}>
      <button type="button" className="scr-linkbtn scr-link" disabled={busy} onClick={() => void run()}>
        {busy ? t("listening.repomap.clone_test.busy") : t("listening.repomap.clone_test.button")}
      </button>
      {unavailable !== null && (
        <p className="scr-hint scr-hint--warn" style={{ margin: "4px 0 0" }}>
          {t(unavailable)}
        </p>
      )}
      {result !== null && result.ok && (
        <p className="scr-hint scr-hint--ok" style={{ margin: "4px 0 0" }}>
          {t("listening.repomap.clone_test.ok", {
            repo: result.repo,
            files: String(result.fileCount ?? 0),
            branch: result.branch ?? "-",
            head: result.head ?? "-",
            seconds: ((result.durationMs ?? 0) / 1000).toFixed(1),
          })}
        </p>
      )}
      {result !== null && !result.ok && (
        <p className="scr-hint scr-hint--warn" style={{ margin: "4px 0 0" }}>
          {t(result.messageKey ?? "listening.repomap.clone_test.failed", { repo: result.repo })}
          {result.detail !== undefined && result.detail !== "" ? ` — ${result.detail}` : ""}
        </p>
      )}
    </div>
  );
}
