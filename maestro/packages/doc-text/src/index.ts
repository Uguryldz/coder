export * from "./zip.js";
export { docxToText, documentXmlToText } from "./docx.js";
export { pdfToText } from "./pdf.js";

import { docxToText } from "./docx.js";
import { pdfToText } from "./pdf.js";

/**
 * What a ticket attachment is, for the analyst's purposes.
 *
 *  · text  — read as UTF-8 (txt, md, csv, json, xml, yaml, log)
 *  · docx  — Word, paragraphs extracted from `word/document.xml`
 *  · pdf   — text layer extracted; a scan has none
 *  · unsupported — named to the model but not read (images, xlsx, pptx,
 *    legacy .doc, archives): saying "there is a screenshot" is still useful,
 *    inventing its content would not be.
 */
export type DocumentKind = "text" | "docx" | "pdf" | "unsupported";

export interface ExtractInput {
  readonly filename: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

export interface ExtractedText {
  readonly kind: DocumentKind;
  /** `null` when the kind is unsupported or the file carries no readable text. */
  readonly text: string | null;
  /** Why `text` is null, in operator language — never a stack trace. */
  readonly note?: string;
}

const TEXT_MIME_EXACT = new Set([
  "application/json",
  "application/xml",
  "application/x-yaml",
  "application/yaml",
  "application/x-ndjson",
]);
const TEXT_EXTENSIONS = new Set(["txt", "md", "markdown", "csv", "tsv", "json", "xml", "yaml", "yml", "log", "ndjson"]);
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/**
 * The kind, from the MIME type first and the extension second. Data Center
 * often reports `application/octet-stream` for anything it did not sniff, so
 * a `.docx` uploaded from a bank desktop would be "unsupported" by MIME alone.
 */
export function documentKindOf(filename: string, mimeType: string): DocumentKind {
  const mime = mimeType.trim().toLowerCase();
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  if (mime === DOCX_MIME || ext === "docx") return "docx";
  if (mime === "application/pdf" || ext === "pdf") return "pdf";
  if (mime.startsWith("text/") || TEXT_MIME_EXACT.has(mime) || TEXT_EXTENSIONS.has(ext)) return "text";
  return "unsupported";
}

export async function extractDocumentText(input: ExtractInput): Promise<ExtractedText> {
  const kind = documentKindOf(input.filename, input.mimeType);
  switch (kind) {
    case "text": {
      const text = Buffer.from(input.bytes).toString("utf8").replace(/^\uFEFF/, "");
      return text.trim() === "" ? { kind, text: null, note: "dosya boş" } : { kind, text };
    }
    case "docx": {
      try {
        const text = docxToText(input.bytes);
        return text.trim() === "" ? { kind, text: null, note: "Word belgesinde okunabilir metin yok" } : { kind, text };
      } catch (error) {
        return { kind, text: null, note: `Word belgesi okunamadı: ${reasonOf(error)}` };
      }
    }
    case "pdf": {
      try {
        const { text, pages } = await pdfToText(input.bytes);
        return text.trim() === ""
          ? { kind, text: null, note: `PDF'te metin katmanı yok (${String(pages)} sayfa — tarama olabilir)` }
          : { kind, text };
      } catch (error) {
        return { kind, text: null, note: `PDF okunamadı: ${reasonOf(error)}` };
      }
    }
    case "unsupported":
      return { kind, text: null, note: `bu tür (${input.mimeType || "bilinmiyor"}) metin olarak okunmuyor` };
  }
}

function reasonOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 160);
}
