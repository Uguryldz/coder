import { DOCX_DOCUMENT_ENTRY, DocxReadError, looksLikeZip, readZipEntry } from "./zip.js";

/**
 * Plain text out of a `.docx`, paragraph per line.
 *
 * Word keeps a paragraph's text in `<w:t>` runs, split wherever formatting
 * changes; a tab is `<w:tab/>` and a manual line break `<w:br/>`. Joining the
 * runs of one `<w:p>` and separating paragraphs by newlines gives the reading
 * order a person sees — headings, body, table cells (each cell is its own
 * paragraph, so a table reads row by row). Nothing about styles, images or
 * headers/footers: the analyst needs what the document SAYS.
 */
export function docxToText(bytes: Uint8Array): string {
  if (!looksLikeZip(bytes)) throw new DocxReadError("not a .docx (missing zip signature)");
  const entry = readZipEntry(bytes, DOCX_DOCUMENT_ENTRY);
  if (entry === null) throw new DocxReadError(`archive has no ${DOCX_DOCUMENT_ENTRY}`);
  return documentXmlToText(Buffer.from(entry).toString("utf8"));
}

/** The paragraph walk, separated so a caller holding the XML can reuse it. */
export function documentXmlToText(xml: string): string {
  const paragraphs = xml.match(/<w:p\b[^>]*>[\s\S]*?<\/w:p>|<w:p\b[^>]*\/>/g) ?? [];
  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    const parts: string[] = [];
    // Runs, tabs and breaks in document order — one regex, one pass.
    for (const match of paragraph.matchAll(/<w:t\b[^>]*>([^<]*)<\/w:t>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>/g)) {
      if (match[0].startsWith("<w:t")) {
        if (match[0].startsWith("<w:tab")) parts.push("\t");
        else parts.push(decodeXml(match[1] ?? ""));
      } else {
        parts.push("\n");
      }
    }
    const line = parts.join("").replace(/[ \t]+$/g, "");
    if (line.trim() !== "") lines.push(line);
  }
  return lines.join("\n");
}

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, "&");
}
