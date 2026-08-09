import { signWebhookBody } from "@maestro/adapter-jira";
import { WEBHOOK_SECRET } from "./fakes.js";

/** Jira DC webhook envelopes, shaped the way the driver's parser reads them. */

export function commentEvent(options: {
  ticket: string;
  author: string;
  body: string;
  event?: "comment_created" | "comment_updated";
  created?: string;
  updated?: string;
}): Record<string, unknown> {
  const created = options.created ?? "2026-08-09T09:05:00.000+0300";
  return {
    webhookEvent: options.event ?? "comment_created",
    timestamp: Date.parse("2026-08-09T06:05:00.000Z"),
    issue: { key: options.ticket, fields: { labels: [] } },
    comment: {
      id: "10501",
      author: { name: options.author },
      body: options.body,
      created,
      updated: options.updated ?? created,
    },
  };
}

export function issueEvent(options: {
  ticket: string;
  labels?: readonly string[];
  event?: string;
}): Record<string, unknown> {
  return {
    webhookEvent: options.event ?? "jira:issue_created",
    timestamp: Date.parse("2026-08-09T06:00:00.000Z"),
    issue: { key: options.ticket, fields: { labels: [...(options.labels ?? [])] } },
  };
}

export interface SignedDelivery {
  payload: string;
  headers: Record<string, string>;
}

/** Sign the exact bytes that will be sent — the signature is over the body. */
export function signed(payload: unknown, secret = WEBHOOK_SECRET): SignedDelivery {
  const body = JSON.stringify(payload);
  return {
    payload: body,
    headers: {
      "content-type": "application/json",
      "x-hub-signature": signWebhookBody(body, secret),
    },
  };
}
