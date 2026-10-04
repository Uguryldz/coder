import { Document, Packer, Paragraph, Table, TableCell, TableRow, TextRun } from "docx";
import PDFDocument from "pdfkit";
import { describe, expect, it } from "vitest";
import { documentKindOf, docxToText, extractDocumentText, pdfToText } from "../src/index.js";

async function docxBytes(): Promise<Uint8Array> {
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ children: [new TextRun("Kredi Limiti Artırma — Analiz")] }),
          new Paragraph({ children: [new TextRun("Amaç: "), new TextRun({ text: "limit artışı", bold: true }), new TextRun(" skor servisinden doğrulanır.")] }),
          new Paragraph({ children: [new TextRun("A < B & C")] }),
          new Table({
            rows: [
              new TableRow({ children: [new TableCell({ children: [new Paragraph("Risk")] }), new TableCell({ children: [new Paragraph("Önlem")] })] }),
              new TableRow({ children: [new TableCell({ children: [new Paragraph("Yanlış müşteri")] }), new TableCell({ children: [new Paragraph("İkinci kontrol")] })] }),
            ],
          }),
        ],
      },
    ],
  });
  return new Uint8Array(await Packer.toBuffer(doc));
}

function pdfBytes(text: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument();
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    doc.on("error", reject);
    doc.text(text);
    doc.end();
  });
}

describe("documentKindOf", () => {
  it("reads the kind from MIME first, extension second — DC often says octet-stream", () => {
    expect(documentKindOf("x.docx", "application/octet-stream")).toBe("docx");
    expect(documentKindOf("x.pdf", "application/octet-stream")).toBe("pdf");
    expect(documentKindOf("x.bin", "text/plain")).toBe("text");
    expect(documentKindOf("notlar.md", "application/octet-stream")).toBe("text");
    expect(documentKindOf("ekran.png", "image/png")).toBe("unsupported");
    expect(documentKindOf("eski.doc", "application/msword")).toBe("unsupported");
    expect(documentKindOf("tablo.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).toBe("unsupported");
  });
});

describe("docx", () => {
  it("returns the paragraphs in reading order, runs joined, table cells as lines, entities decoded", async () => {
    const text = docxToText(await docxBytes());
    const lines = text.split("\n");
    expect(lines[0]).toBe("Kredi Limiti Artırma — Analiz");
    expect(lines[1]).toBe("Amaç: limit artışı skor servisinden doğrulanır.");
    expect(lines[2]).toBe("A < B & C");
    expect(lines.slice(3)).toEqual(["Risk", "Önlem", "Yanlış müşteri", "İkinci kontrol"]);
  });

  it("refuses a non-zip and an archive without word/document.xml", async () => {
    expect(() => docxToText(new Uint8Array([1, 2, 3, 4, 5]))).toThrow(/not a \.docx/);
    const result = await extractDocumentText({ filename: "x.docx", mimeType: "application/octet-stream", bytes: new Uint8Array([1, 2, 3, 4, 5]) });
    expect(result.kind).toBe("docx");
    expect(result.text).toBeNull();
    expect(result.note).toMatch(/Word belgesi okunamadı/);
  });
});

describe("pdf", () => {
  it("extracts the text layer", async () => {
    const { text, pages } = await pdfToText(await pdfBytes("Teminat mektubu vade takibi"));
    expect(pages).toBe(1);
    expect(text).toContain("Teminat mektubu vade takibi");
  });

  it("reports a PDF with no text layer as unreadable rather than empty", async () => {
    const empty = await pdfBytes(" ");
    const result = await extractDocumentText({ filename: "tarama.pdf", mimeType: "application/pdf", bytes: empty });
    expect(result.kind).toBe("pdf");
    expect(result.text).toBeNull();
    expect(result.note).toMatch(/metin katmanı yok/);
  });
});

describe("extractDocumentText", () => {
  it("decodes text files as UTF-8 and strips a BOM", async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from("şğı ok", "utf8")]);
    const result = await extractDocumentText({ filename: "n.txt", mimeType: "text/plain", bytes });
    expect(result).toEqual({ kind: "text", text: "şğı ok" });
  });

  it("names an unsupported kind without inventing content", async () => {
    const result = await extractDocumentText({ filename: "ekran.png", mimeType: "image/png", bytes: new Uint8Array([1]) });
    expect(result.kind).toBe("unsupported");
    expect(result.text).toBeNull();
    expect(result.note).toContain("image/png");
  });
});
