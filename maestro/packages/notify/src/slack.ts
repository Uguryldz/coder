import type { Notification } from "@maestro/contracts";
import { SLACK_DRIVER, type WebhookDriverConfig } from "./config.js";
import { type WebhookDeps, WebhookNotifier } from "./webhook.js";

/**
 * Slack Incoming Webhook (M45 — shipped, off by default). `text` is the
 * notification/fallback line, `blocks` the rendered body. Text is catalog
 * output (M104); nothing is composed here.
 */
export function buildSlackMessage(_notification: Notification, subject: string, body: string): unknown {
  return {
    text: subject,
    blocks: [{ type: "section", text: { type: "mrkdwn", text: escapeMrkdwn(body) } }],
  };
}

/**
 * Slack's mrkdwn treats `&`, `<` and `>` as markup. A ticket summary
 * containing `<script>` or `A & B` would otherwise render mangled or be
 * misread as a link.
 */
export function escapeMrkdwn(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Slack replies `ok` on success; anything else on a 2xx is a refusal. */
export function slackBodyFailure(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.toLowerCase() === "ok") return null;
  return /fail|error|invalid|no_service|no_team/i.test(trimmed) ? trimmed : null;
}

export function createSlackNotifier(config: WebhookDriverConfig, deps: WebhookDeps): WebhookNotifier {
  return new WebhookNotifier(
    { channel: SLACK_DRIVER, buildPayload: buildSlackMessage, checkBody: slackBodyFailure },
    config,
    deps,
  );
}
