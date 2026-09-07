import { extractText, getDocumentProxy } from "unpdf";

/**
 * Plain text out of a PDF, pages merged. `unpdf` is pdf.js packaged for a
 * server without a DOM, so a bank's on-prem worker needs no browser shim.
 * Scanned PDFs (images of text) yield an empty string — that is reported by
 * the caller as "no readable text", never as an empty document that reads as
 * "nothing in it".
 */
export async function pdfToText(bytes: Uint8Array): Promise<{ text: string; pages: number }> {
  const document = await getDocumentProxy(new Uint8Array(bytes));
  const { text, totalPages } = await extractText(document, { mergePages: true });
  return { text, pages: totalPages };
}
