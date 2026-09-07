import { extractDocumentText } from "@maestro/doc-text";
import type { TicketKey, TicketSnapshot } from "@maestro/contracts";
import type { ActivityDeps, AttachmentMeta } from "./deps.js";

/** How many attachments go to the model — the first N as Jira lists them. */
export const MAX_ATTACHMENTS = 8;
/** A download larger than this is named but not fetched. */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
/** Characters of one attachment's text the prompt carries. */
export const MAX_ATTACHMENT_CHARS = 20_000;
/** Characters across ALL attachments — a chatty ticket cannot blow the prompt. */
export const MAX_TOTAL_CHARS = 60_000;

/**
 * What the analyst sees for one attachment. `text` is present when the file
 * was read; otherwise `note` says why not — an unread attachment is still
 * NAMED, because "there is a screenshot of the error" is context even when
 * the screenshot cannot be read, and the model is told to say the file must
 * be reviewed rather than to guess its content.
 */
export interface AttachmentForModel {
  readonly name: string;
  /** Operator-facing kind: metin / word / pdf / okunmadı. */
  readonly kind: string;
  readonly text?: string;
  readonly note?: string;
}

export type AttachmentWarn = (message: string) => void;

const KIND_LABEL: Record<string, string> = { text: "metin", docx: "word", pdf: "pdf", unsupported: "okunmadı" };

/**
 * The ticket's attachments, read and reduced to text — inside the activity,
 * never on the workflow. Fail-soft at every step: a driver without the seam,
 * a listing that fails, a download that fails or a file that cannot be
 * extracted each cost the model that one piece of context and nothing else,
 * and each says so in the worker log.
 */
export async function ticketAttachments(
  deps: ActivityDeps,
  ticket: TicketKey,
  warn: AttachmentWarn = (message) => console.warn(message),
): Promise<readonly AttachmentForModel[]> {
  const reader = deps.attachments;
  if (reader === undefined) return [];

  let metas: readonly AttachmentMeta[];
  try {
    metas = await reader.listAttachments(ticket);
  } catch (error) {
    warn(`[maestro] attachments: ${ticket} eklerinin listesi okunamadı (${String(error)}) — analiz eksiz devam ediyor.`);
    return [];
  }
  if (metas.length === 0) return [];

  const out: AttachmentForModel[] = [];
  let total = 0;
  for (const meta of metas.slice(0, MAX_ATTACHMENTS)) {
    const name = meta.filename.trim() === "" ? "(adsız ek)" : meta.filename.trim();
    if (meta.size > MAX_ATTACHMENT_BYTES) {
      out.push({ name, kind: "okunmadı", note: `dosya çok büyük (${String(Math.round(meta.size / 1024))} KB) — indirilmedi` });
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = await reader.downloadBytes(meta.contentUrl);
    } catch (error) {
      warn(`[maestro] attachments: ${ticket} eki '${name}' indirilemedi (${String(error)}).`);
      out.push({ name, kind: "okunmadı", note: "indirilemedi" });
      continue;
    }
    const extracted = await extractDocumentText({ filename: name, mimeType: meta.mimeType, bytes });
    const kind = KIND_LABEL[extracted.kind] ?? "okunmadı";
    if (extracted.text === null) {
      out.push({ name, kind, ...(extracted.note === undefined ? {} : { note: extracted.note }) });
      continue;
    }
    const room = Math.min(MAX_ATTACHMENT_CHARS, MAX_TOTAL_CHARS - total);
    if (room <= 0) {
      out.push({ name, kind, note: "toplam ek metni sınırı doldu — bu ek okunmadı" });
      continue;
    }
    const clipped = extracted.text.length > room;
    const text = clipped ? extracted.text.slice(0, room) : extracted.text;
    total += text.length;
    out.push({ name, kind, text, ...(clipped ? { note: `kısaltıldı (${String(extracted.text.length)} karakterden ${String(room)})` } : {}) });
  }
  if (metas.length > MAX_ATTACHMENTS) {
    warn(`[maestro] attachments: ${ticket} üzerinde ${String(metas.length)} ek var; ilk ${String(MAX_ATTACHMENTS)} tanesi okundu.`);
  }
  return out;
}

/** Eklerin açıklamaya eklenirken kullandığı başlık — yorum bloğuyla aynı üslup. */
export const ATTACHMENT_BLOCK_TITLE =
  "--- EKLER (ticket'a eklenmiş dosyaların metni; okunamayan ek yalnız adıyla anılır) ---";

/**
 * Intake yolu için: ekler ticket açıklamasının ARDINA bir blok olarak eklenir,
 * yorumların eklendiği gibi (`withComments`). Ek yoksa snapshot aynen döner.
 * Okunamayan ek de listelenir — "ekteki ekran görüntüsüne bakın" diyen bir
 * ticket'ı "ek yok" sanmak, eksik bilgi sorusunu yanlış yere sorar.
 */
export function withAttachments(
  snapshot: TicketSnapshot,
  attachments: readonly AttachmentForModel[],
): TicketSnapshot {
  if (attachments.length === 0) return snapshot;
  const blocks = attachments.map((a) => {
    const head = `[ek: ${a.name} (${a.kind}${a.note === undefined ? "" : ` — ${a.note}`})]`;
    return a.text === undefined ? head : `${head}\n${a.text}`;
  });
  return {
    ...snapshot,
    description: `${snapshot.description}\n\n${ATTACHMENT_BLOCK_TITLE}\n${blocks.join("\n\n")}`,
  };
}
