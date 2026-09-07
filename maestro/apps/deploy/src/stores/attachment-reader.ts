import type { WorkPort } from "@maestro/ports";
import type { AttachmentMeta, AttachmentReader } from "@maestro/workflows";

type ReadAttachmentsFn = (ticket: string) => Promise<readonly AttachmentMeta[]>;
type DownloadBytesFn = (contentUrl: string) => Promise<Uint8Array>;

/**
 * The ticket's attachments, for the analyst — matched to the driver the way
 * `docAttacherFor` and `commentReaderFor` are: by asking the concrete port
 * whether it carries the two capabilities, not by naming a class. Both Jira
 * drivers carry them now (Cloud always did; Data Center reads
 * `fields=attachment` and downloads from `/secure/attachment/...` with the
 * PAT). A driver without them yields `undefined`, and the analysis proceeds
 * on the ticket's text alone — the way it did before attachments were read.
 */
export function attachmentReaderFor(work: WorkPort): AttachmentReader | undefined {
  const candidate = work as Partial<Record<"readAttachments" | "downloadAttachmentBytes", unknown>>;
  if (typeof candidate.readAttachments !== "function" || typeof candidate.downloadAttachmentBytes !== "function") {
    return undefined;
  }
  const list = candidate.readAttachments.bind(work) as ReadAttachmentsFn;
  const download = candidate.downloadAttachmentBytes.bind(work) as DownloadBytesFn;
  return {
    listAttachments: (ticket) => list(ticket),
    downloadBytes: (contentUrl) => download(contentUrl),
  };
}
