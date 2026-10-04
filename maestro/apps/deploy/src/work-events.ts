import { parseWebhookEvent } from "@maestro/adapter-jira";
import type { WorkEvent, WorkEventReader } from "@maestro/bff";

/**
 * The `WorkEventReader` the BFF injects.
 *
 * `WorkPort` has no `parseEvent`, so the BFF declares the narrow shape it needs
 * out of a VERIFIED delivery and the composition root builds it from the same
 * driver the work port came from. Deriving it here — rather than in the BFF —
 * is what keeps `apps/bff` free of a Jira import (M44).
 *
 * The reader is deliberately not a re-implementation: it delegates to the
 * driver's own `parseWebhookEvent` and only narrows the result. A second
 * parser would be a second grammar to keep in step with Jira, and the two
 * would drift on the first payload shape nobody thought to test.
 */
/**
 * THE THREE FIELD READERS ARE EXPORTED, and that is the point of them.
 *
 * A webhook delivery and a JQL search result are the SAME `issue` document —
 * `fields.status.name`, `fields.labels`, `fields.assignee.accountId` — served
 * by two endpoints. The discovery sweep (`jira-discovery.ts`) now reads the
 * same three fields off its search page so a swept ticket reaches intake as
 * fully described as a delivered one. Sharing these functions rather than
 * writing a second set is not tidiness: two hand-rolled grammars for one Jira
 * document is exactly how the two entry points end up classifying the same
 * ticket differently, which is the failure this whole change is undoing.
 */
export function jiraWorkEventReader(): WorkEventReader {
  return {
    read(payload: unknown): WorkEvent {
      const event = parseWebhookEvent(payload);
      if (event.kind === "other") return { kind: "other" };

      // Labels decide whether an `opt_in` project takes the ticket at all
      // (M48a), so they are read from the issue the driver already validated
      // rather than from the raw envelope.
      const labels = labelsOf(event.issue);
      // Status, issue type and assignee decide which FLOW the ticket runs
      // (`apps/bff/src/flow-decision.ts`). They are read from the delivery for
      // the same reason labels are: the frozen `TicketSnapshot` carries no
      // status at all, so a second Jira round-trip would be the only other way
      // to learn it — and it would be a different read of a moving ticket.
      const status = nameOf(event.issue, "status");
      const issueType = nameOf(event.issue, "issuetype");
      // AYNI İKİ ALANIN KİMLİKLERİ. Takım yönetimli (next-gen) bir projede JQL
      // adları çözmediği için kural İD tutar, ve `flow-decision.ts` sayısal bir
      // `matchValue`'yu ticket'ın İD'siyle karşılaştırır. Teslimat ikisini de
      // taşıyor (`fields.status.id`, `fields.issuetype.id`); okumamak, kuralın
      // bulduğu ticket'ı kuralın kendisiyle eşleştirememek olurdu.
      const statusId = idOf(event.issue, "status");
      const issueTypeId = idOf(event.issue, "issuetype");
      const assignee = assigneeOf(event.issue);
      // Değişikliği YAPAN kişi. Yalnız issue olaylarında var ve tek bir iş
      // için taşınıyor: netleştirme yeniden girişinde Maestro'nun kendi
      // hareketinin yankısını ayıklamak (`apps/bff/src/routes/webhooks.ts`).
      const actor = event.kind === "issue" ? event.actor : null;
      return {
        kind: event.kind,
        ticketKey: event.ticketKey,
        ...(labels === null ? {} : { labels }),
        ...(status === null ? {} : { status }),
        ...(statusId === null ? {} : { statusId }),
        ...(issueType === null ? {} : { issueType }),
        ...(issueTypeId === null ? {} : { issueTypeId }),
        ...(assignee === null ? {} : { assignee }),
        ...(actor === null ? {} : { actor }),
      };
    },
  };
}

/**
 * `issue.fields.labels`, or `null` when the payload carries none.
 *
 * `null` and `[]` are different answers and the difference matters: an empty
 * array says "this ticket has no labels", which in an `opt_in` project means
 * "do not take it". A payload that simply omitted the field must not be read
 * as that, so it stays absent and the caller decides.
 */
export function labelsOf(issue: unknown): string[] | null {
  const fields = asRecord(asRecord(issue)?.["fields"]);
  const labels = fields?.["labels"];
  if (!Array.isArray(labels)) return null;
  return labels.filter((label): label is string => typeof label === "string");
}

/**
 * `issue.fields.<field>.name`, or `null` when the payload carries none.
 *
 * Both `status` and `issuetype` are objects with a `name` in every Jira flavour
 * (DC and Cloud alike), which is the value a listening rule's `matchValue`
 * holds — an admin picks it off the Studio screen as the words they see in
 * Jira. Whitespace-only is treated as absent: a rule must not match on it.
 */
export function nameOf(issue: unknown, field: string): string | null {
  const fields = asRecord(asRecord(issue)?.["fields"]);
  const name = asRecord(fields?.[field])?.["name"];
  return typeof name === "string" && name.trim().length > 0 ? name.trim() : null;
}

/**
 * `issue.fields.<field>.id`, or `null` when the payload carries none.
 *
 * `nameOf`'un kimlik ikizi ve aynı gerekçeyle EXPORT: teslimat ile arama
 * sonucu aynı belge, ve iki yüzeyin aynı belgeyi iki el yazması gramerle
 * okuması, aynı ticket'ı farklı sınıflandırmalarının kestirme yolu.
 *
 * Jira id'yi hem metin hem sayı olarak gönderebiliyor; ikisi de metne
 * çevriliyor, çünkü kuralın `matchValue`'su metin ve karşılaştırma
 * (`flow-decision.ts`) metin üzerinden yapılıyor.
 */
export function idOf(issue: unknown, field: string): string | null {
  const fields = asRecord(asRecord(issue)?.["fields"]);
  const id = asRecord(fields?.[field])?.["id"];
  if (typeof id === "number" && Number.isFinite(id)) return String(id);
  return typeof id === "string" && id.trim().length > 0 ? id.trim() : null;
}

/**
 * The assignee, in the form the listening rules store it.
 *
 * `accountId` FIRST because that is what `ListeningRule.assigneeAccountId`
 * holds and, on Jira Cloud, the only identifier an assignee object carries at
 * all — `name`/`key`/`emailAddress` are absent there (the same asymmetry that
 * broke membership checks, HANDOFF item 3). The DC fields follow as a fallback
 * so a Data Center deployment, whose users have no `accountId`, still matches.
 *
 * `null` (unassigned, or a payload that omitted the field) matches only rules
 * that name no assignee.
 */
export function assigneeOf(issue: unknown): string | null {
  const fields = asRecord(asRecord(issue)?.["fields"]);
  const assignee = asRecord(fields?.["assignee"]);
  if (assignee === null) return null;
  for (const key of ["accountId", "name", "key", "emailAddress"]) {
    const value = assignee[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
