import { createLogger, loadConfig } from "@orkestra/config";
import axios, { AxiosInstance } from "axios";

const log = createLogger("slack");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SlackBlock {
  type: string;
  [key: string]: unknown;
}

export interface SlackSendOptions {
  /** Optional title/channel-level heading shown above the text. */
  title?: string;
  /** Optional extra Block Kit blocks appended to the message. */
  blocks?: SlackBlock[];
  /** Emoji or icon_url override (if your webhook allows it). */
  iconEmoji?: string;
  /** Display name override (if your webhook allows it). */
  username?: string;
}

export interface SlackDigestSummary {
  title: string;
  workflowRunId?: string;
  ticketKey?: string;
  lines: string[];
  url?: string;
}

export interface SlackNotifierOptions {
  webhookUrl?: string;
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Notifier
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget Slack webhook notifier.
 *
 * - If `SLACK_WEBHOOK_URL` is empty, every method is a no-op.
 * - Never throws: failures are logged and swallowed so the workflow can
 *   continue even if Slack is down.
 */
export class SlackNotifier {
  private readonly http: AxiosInstance;
  private readonly webhookUrl: string;

  constructor(opts: SlackNotifierOptions = {}) {
    const cfg = loadConfig();
    this.webhookUrl = opts.webhookUrl ?? cfg.SLACK_WEBHOOK_URL;
    this.http = axios.create({
      timeout: opts.timeoutMs ?? 5_000,
      headers: { "Content-Type": "application/json" },
    });
  }

  get isConfigured(): boolean {
    return Boolean(this.webhookUrl);
  }

  async sendCritical(textMsg: string, opts: SlackSendOptions = {}): Promise<void> {
    const blocks: SlackBlock[] = [];
    const title = opts.title ?? "Orkestra — critical";
    blocks.push({
      type: "header",
      text: { type: "plain_text", text: title, emoji: true },
    });
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: textMsg },
    });
    if (opts.blocks && opts.blocks.length > 0) blocks.push(...opts.blocks);

    await this.post({
      text: `${title}: ${textMsg}`,
      blocks,
      username: opts.username,
      icon_emoji: opts.iconEmoji ?? ":rotating_light:",
    });
  }

  async sendDigest(summary: SlackDigestSummary): Promise<void> {
    const headerLines: string[] = [];
    if (summary.ticketKey) headerLines.push(`*Ticket:* ${summary.ticketKey}`);
    if (summary.workflowRunId) headerLines.push(`*Run:* ${summary.workflowRunId}`);

    const body = [...headerLines, ...summary.lines].join("\n");

    const blocks: SlackBlock[] = [
      { type: "header", text: { type: "plain_text", text: summary.title, emoji: true } },
      { type: "section", text: { type: "mrkdwn", text: body || "_(no details)_" } },
    ];
    if (summary.url) {
      blocks.push({
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Open in Orkestra", emoji: true },
            url: summary.url,
          },
        ],
      });
    }

    await this.post({ text: summary.title, blocks });
  }

  // -------------------------------------------------------------------------

  private async post(payload: Record<string, unknown>): Promise<void> {
    if (!this.isConfigured) {
      log.debug({ payload }, "slack not configured — skipping");
      return;
    }
    try {
      await this.http.post(this.webhookUrl, payload);
    } catch (err) {
      const msg = axios.isAxiosError(err)
        ? `${err.response?.status ?? "?"} ${
            typeof err.response?.data === "string" ? err.response.data : err.message
          }`
        : err instanceof Error
          ? err.message
          : String(err);
      log.warn({ err: msg }, "slack webhook post failed (swallowed)");
    }
  }
}
