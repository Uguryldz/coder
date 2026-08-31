import type { CommandIntakeDecision } from "./command-intake.js";

/**
 * The ONE line an operator sends us when "dinleme çalışmıyor".
 *
 * A gate that waits forever has four possible causes and they need four
 * different fixes — and until this line existed, all four produced the same
 * evidence: nothing. The operator could not tell whether
 *
 *   (a) the poller was running at all,
 *   (b) the webhook never arrived or arrived and was refused,
 *   (c) Jira was reachable,
 *   (d) which driver was installed and whether it can read a comment at all,
 *
 * and neither could we, from a screenshot of a green start-up log. This banner
 * answers (a) and (d) outright, and it names the endpoint and the interval that
 * make (b) and (c) readable in the round lines that follow it.
 *
 * It is printed ONCE, at boot, before the first round — it is the first thing
 * in the log and the first thing to ask for.
 *
 * NOTHING SECRET GOES IN IT. Not the PAT, not the webhook secret, not the
 * `Authorization` header: it carries a driver id, a path, an interval and two
 * booleans, every one of which is a deployment fact rather than a credential.
 * The base URL is not here either — the wiring banner already prints it, and
 * repeating a URL that may carry userinfo is how a secret reaches a log by
 * accident.
 */
export interface ListeningBanner {
  /** The work driver id as the registry names it, e.g. `jira-dc`. */
  readonly driver: string;
  /** Whether that driver can read a comment thread (`listComments`). */
  readonly canReadComments: boolean;
  /** The path Jira must be able to POST to. Never the full URL. */
  readonly webhookPath: string;
  /** What is in force: webhook-only, polling, or both — and where it came from. */
  readonly intake: CommandIntakeDecision;
}

/** Where the answer in force came from, in the operator's words. */
function sourceLabel(source: CommandIntakeDecision["source"]): string {
  if (source === "param") return "panel ayarı";
  if (source === "env") return "JIRA_POLL_MS";
  return "varsayılan";
}

/** The intake mode in the operator's words, interval included. */
export function intakeLabel(decision: CommandIntakeDecision): string {
  if (decision.mode === "webhook") return "yalnız webhook";
  const every = `${decision.pollSeconds} sn`;
  return decision.mode === "poll" ? `yalnız yoklama (${every})` : `webhook + yoklama (${every})`;
}

/**
 * The banner, as the line that is printed.
 *
 * One line rather than a block: an operator copies a line out of a container
 * log, and a block gets truncated at whatever the terminal wrapped. Every fact
 * is `key=value` so it survives being pasted into a ticket.
 */
export function listeningBannerLine(banner: ListeningBanner): string {
  const parts = [
    `sürücü=${banner.driver}`,
    `webhook=${banner.webhookPath}`,
    `komut-alımı=${intakeLabel(banner.intake)}`,
    `kaynak=${sourceLabel(banner.intake.source)}`,
    `yorum-okuma=${banner.canReadComments ? "var" : "YOK"}`,
  ];
  return `[dinleme] ${parts.join(" ")}`;
}

/**
 * The sentence that follows the banner when something is off — or nothing.
 *
 * The banner states facts; this states the CONSEQUENCE, and only when there is
 * one worth stating. An operator reading `yorum-okuma=YOK` should not have to
 * know what that implies about `/approve`.
 */
export function listeningWarningLine(banner: ListeningBanner): string | null {
  if (!banner.canReadComments) {
    return (
      "[dinleme] UYARI: bu iş sürücüsü yorum OKUYAMIYOR — ticket'a yazılan /approve " +
      "yalnız webhook ile alınabilir, yoklama açılamaz. Webhook Jira'dan bu adrese " +
      `ulaşamıyorsa onaylar panelden verilmelidir. (Yorum okumayı Jira Cloud ve Jira ` +
      "Data Center sürücüleri sunar; kurulu sürücü bunlardan biri değil.)"
    );
  }
  if (banner.intake.mode === "webhook") {
    return (
      "[dinleme] Yoklama KAPALI — komutlar yalnız webhook ile alınır. Jira bu adrese " +
      "çıkamıyorsa (kapalı ağ, kayıtsız webhook) ticket'a yazılan /approve HİÇ okunmaz; " +
      "kurulum sihirbazından 'biz Jira'ya soralım' seçeneğini açın."
    );
  }
  return null;
}
