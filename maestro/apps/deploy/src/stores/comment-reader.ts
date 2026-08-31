import type { WorkPort } from "@maestro/ports";
import type { CommentReader } from "@maestro/workflows";

/**
 * Hand the worker the ability to READ a ticket's comment thread.
 *
 * The same M44 split, the same shape and the same structural detection as
 * `doc-attacher.ts` and `status-mover.ts` next door. `WorkPort` is FROZEN, and
 * `listComments` is deliberately outside it: the port carries what the WORKFLOW
 * ENGINE needs, and reading a thread is not that (the engine is signalled, it
 * does not look). The capability is real on both concrete Jira drivers — Cloud
 * has had it, Data Center grew it for the comment poller — so this file, in the
 * composition root, is the one place allowed to know which driver satisfies it.
 *
 * ── NEDEN AKIŞIN BUNA İHTİYACI VAR ──────────────────────────────────────────
 * Intake `getTicket` snapshot'ını okur. Reporter'ın netleştirme sorusuna yazdığı
 * CEVAP ise snapshot'ta değil — bir yorum. Re-entry köprüsü koşuyu uyandırınca
 * intake yine aynı ince ticket'ı görür, yine "eksik" der: sonsuz iade döngüsü,
 * cevap yazılmış olmasına rağmen. `@maestro/workflows` bu yüzden ihtiyaç
 * duyduğu ŞEKLİ (`CommentReader`) bildiriyor, burası da onu karşılayan sürücüyü
 * veriyor.
 */

/** Both concrete drivers' signature, as `listComments` has it on each. */
type ListCommentsFn = (ticket: string) => Promise<unknown[]>;

/**
 * The comment reader this deployment's work driver supports, or `undefined`.
 *
 * `undefined` is a supported answer, not a degradation to paper over: a work
 * driver with no comment API at all (a future non-Jira port) is better off with
 * no seam than with a stub — intake then reads the ticket alone, which is
 * exactly what it did before this seam existed.
 *
 * `botAccountId` — `MAESTRO_BOT_ACCOUNT_ID`, the same variable the comment
 * poller reads — filters Maestro's OWN comments out of the context. Absent is
 * tolerated rather than fatal: intake then also sees the question it asked
 * itself, which is noisy but not wrong (the question is on the ticket anyway),
 * and `readHumanComments` says so in a warning line. Making it required would
 * turn an unset optional variable into a worker that refuses to start.
 */
export function commentReaderFor(work: WorkPort, botAccountId?: string): CommentReader | undefined {
  const candidate = (work as Partial<Record<"listComments", unknown>>).listComments;
  if (typeof candidate !== "function") return undefined;
  const list = candidate.bind(work) as ListCommentsFn;
  const bot = botAccountId?.trim() ?? "";
  return {
    listComments: (ticket) => list(ticket),
    ...(bot === "" ? {} : { botUserId: bot }),
  };
}
