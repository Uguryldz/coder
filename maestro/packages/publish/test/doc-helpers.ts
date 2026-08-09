import { inflateRawSync } from "node:zlib";
import { Document, Packer, Paragraph, TextRun } from "docx";
import type { DocTemplateFile, TemplatePlaceholder } from "../src/doc-template.js";

/**
 * Fixtures for the binary-document drivers.
 *
 * The template fixture is a REAL `.docx` built with the same library the driver
 * patches, because the thing under test is whether an institution's file
 * survives patching — a hand-rolled zip would only prove our own assumptions.
 */

export const ANALYSIS_MARKDOWN = [
  "<!-- maestro:doc kind=analysis run=run-20260808-0001 template=analysis-template@1.4.0 -->",
  "# UGURPAY-123 — Analiz",
  "",
  "- **Ticket:** UGURPAY-123",
  "- **Koşu:** run-20260808-0001",
  "",
  "## Amaç",
  "",
  "Kart limit artırım akışını otomatikleştirmek.",
  "",
  "## Kapsam",
  "",
  "- Limit artırım servisi",
  "- Mobil ekran",
  "",
  "## Risk ve geri dönüş",
  "",
  "Riskli alan: limit hesaplama. `maxLimit` ayarı gözden geçirilmeli.",
  "",
  "```yaml",
  "maxLimit: 50000",
  "```",
  "",
].join("\n");

/**
 * Build a corporate `.docx` carrying `tokens` plus text of its own, and the
 * `DocTemplateFile` metadata that says those tokens were recognised.
 *
 * `docx`'s patcher matches a placeholder inside a paragraph's text, so each
 * token gets its own paragraph — the same way a real corporate template marks
 * the slot it wants filled.
 */
export async function docxTemplate(
  tokens: readonly string[],
): Promise<{ bytes: Uint8Array; template: DocTemplateFile }> {
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ children: [new TextRun("KURUMSAL USTBILGI")] }),
          ...tokens.map((token) => new Paragraph({ children: [new TextRun(token)] })),
          new Paragraph({ children: [new TextRun("KURUMSAL ALTBILGI")] }),
        ],
      },
    ],
  });
  const bytes = new Uint8Array(await Packer.toBuffer(doc));
  const placeholders: TemplatePlaceholder[] = tokens.map((token) => ({
    token,
    descriptionKey: "publish.doc.placeholder",
    location: "body",
    found: true,
  }));
  return {
    bytes,
    template: {
      fileName: "kurumsal-sablon.docx",
      version: 3,
      uploadedAt: "2026-08-01T00:00:00.000Z",
      uploadedBy: "doc.owner@corp",
      sizeBytes: bytes.byteLength,
      styles: ["Normal", "Heading1"],
      placeholders,
    },
  };
}

/**
 * Minimal ZIP reader: entry name → uncompressed bytes.
 *
 * Written here rather than pulled in as a test dependency because it is used to
 * VERIFY the driver's output, and a verifier that shares a library with the
 * thing it verifies proves less. Handles the two methods `docx` emits (stored
 * and deflate) and reads the central directory rather than scanning for local
 * headers, so an entry whose name appears in file DATA cannot fool it.
 */
export function readZip(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(bytes, view);
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);

  const entries = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) break;
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));

    // The local header repeats the name/extra lengths, and its extra field is
    // not always the same length as the central one.
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = bytes.subarray(dataStart, dataStart + compressedSize);
    entries.set(name, method === 0 ? data : new Uint8Array(inflateRawSync(data)));

    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Async wrapper so tests read the same whether or not inflation is async. */
export function unzip(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  return Promise.resolve(readZip(bytes));
}

function findEocd(bytes: Uint8Array, view: DataView): number {
  for (let i = bytes.byteLength - 22; i >= 0; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) return i;
  }
  throw new Error("not a zip file: no end-of-central-directory record");
}
