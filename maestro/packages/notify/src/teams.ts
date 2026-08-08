import type { Notification } from "@maestro/contracts";
import { TEAMS_DRIVER, type WebhookDriverConfig } from "./config.js";
import { type WebhookDeps, WebhookNotifier } from "./webhook.js";

/**
 * Microsoft Teams Incoming Webhook (M45). The payload is an Adaptive Card
 * wrapped in the `message`/`attachments` envelope Teams requires — a bare
 * card is rejected with HTTP 400.
 *
 * The card carries ONLY catalog text (M104): no label, no heading and no
 * hardcoded English is composed here, because a Turkish approver must not
 * receive a half-English card.
 */
const ADAPTIVE_CARD_CONTENT_TYPE = "application/vnd.microsoft.card.adaptive";
const CARD_SCHEMA = "http://adaptivecards.io/schemas/adaptive-card.json";
/** 1.4 is the highest version Teams renders in every supported client. */
const CARD_VERSION = "1.4";

export function buildAdaptiveCardMessage(_notification: Notification, subject: string, body: string): unknown {
  const firstLine = body.split(/\r?\n/, 1)[0] ?? body;
  // When the subject had to be shortened, the detail block repeats the WHOLE
  // body: a card that silently drops the end of a sentence is worse than one
  // that shows the headline twice.
  const detail = firstLine.trim() === subject ? body.slice(firstLine.length).trim() : body.trim();
  const blocks: unknown[] = [
    { type: "TextBlock", text: subject, weight: "Bolder", size: "Medium", wrap: true },
  ];
  if (detail.length > 0) {
    blocks.push({ type: "TextBlock", text: detail, wrap: true });
  }

  return {
    type: "message",
    summary: subject,
    attachments: [
      {
        contentType: ADAPTIVE_CARD_CONTENT_TYPE,
        contentUrl: null,
        content: {
          $schema: CARD_SCHEMA,
          type: "AdaptiveCard",
          version: CARD_VERSION,
          body: blocks,
        },
      },
    ],
  };
}

/**
 * Teams answers 200 even when it refuses the card (the classic connector
 * replies `1` on success and a "…delivery failed…" sentence otherwise), so a
 * plain status check would be fail-open.
 */
export function teamsBodyFailure(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed === "1") return null;
  return /fail|error|invalid/i.test(trimmed) ? trimmed : null;
}

export function createTeamsNotifier(config: WebhookDriverConfig, deps: WebhookDeps): WebhookNotifier {
  return new WebhookNotifier(
    { channel: TEAMS_DRIVER, buildPayload: buildAdaptiveCardMessage, checkBody: teamsBodyFailure },
    config,
    deps,
  );
}
