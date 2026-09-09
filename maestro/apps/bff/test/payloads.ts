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
  /** Issue type name, as a listening rule's `matchKind: "issuetype"` reads it. */
  issueType?: string;
  /** Status name, as a listening rule's `matchKind: "status"` reads it. */
  status?: string;
  /**
   * AYNI İKİ ALANIN Jira KİMLİKLERİ — takım yönetimli (next-gen) bir projede
   * kuralın tuttuğu değerler. Jira her ikisini de `{id, name}` olarak
   * gönderiyor; ayrı seçenek, çünkü şirket yönetimli projeyi anlatan testler
   * kimliksiz teslimatı aynen sürdürmeli.
   */
  issueTypeId?: string;
  statusId?: string;
  /** Assignee accountId, as `ListeningRule.assigneeAccountId` stores it. */
  assignee?: string;
  /**
   * Değişikliği YAPAN hesap — Jira'nın her issue olayında gönderdiği `user`
   * alanı. Netleştirme yeniden girişinin yankı koruması bunu okuyor.
   */
  actor?: string;
}): Record<string, unknown> {
  return {
    webhookEvent: options.event ?? "jira:issue_created",
    timestamp: Date.parse("2026-08-09T06:00:00.000Z"),
    ...(options.actor === undefined ? {} : { user: { accountId: options.actor } }),
    issue: {
      key: options.ticket,
      fields: {
        labels: [...(options.labels ?? [])],
        // Shaped exactly as Jira sends them: objects with a `name`, and an
        // assignee identified by `accountId` on Cloud.
        ...(options.issueType === undefined && options.issueTypeId === undefined
          ? {}
          : {
              issuetype: {
                ...(options.issueType === undefined ? {} : { name: options.issueType }),
                ...(options.issueTypeId === undefined ? {} : { id: options.issueTypeId }),
              },
            }),
        ...(options.status === undefined && options.statusId === undefined
          ? {}
          : {
              status: {
                ...(options.status === undefined ? {} : { name: options.status }),
                ...(options.statusId === undefined ? {} : { id: options.statusId }),
              },
            }),
        ...(options.assignee === undefined ? {} : { assignee: { accountId: options.assignee } }),
      },
    },
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
