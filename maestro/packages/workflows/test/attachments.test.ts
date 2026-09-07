import type { LlmCallLog } from "@maestro/contracts";
import { describe, expect, it } from "vitest";
import { writeAnalysis } from "../src/impl/analysis.js";
import { runIntake } from "../src/impl/intake.js";
import {
  ATTACHMENT_BLOCK_TITLE,
  MAX_ATTACHMENT_CHARS,
  MAX_ATTACHMENTS,
  ticketAttachments,
  withAttachments,
} from "../src/impl/attachments.js";
import type { AttachmentMeta } from "../src/impl/deps.js";
import { makeFakes } from "./fakes.js";
import { analysisDoc } from "./harness.js";

const TICKET = "PAY-101";
const LOG: LlmCallLog = {
  at: "2026-09-05T09:00:00+03:00",
  runId: null,
  role: "analyst",
  variantId: "v1",
  driver: "openai-compat",
  model: "fake",
  tokensIn: 0,
  tokensOut: 0,
  cachePct: null,
  usd: null,
  dataClass: "dahili",
};
const okAnalysis = () => ({ status: "ok" as const, value: analysisDoc("orta"), log: LOG });
const okIntake = () => ({ status: "ok" as const, value: { complete: true, missing: [] }, log: LOG });

/**
 * Ticket ekleri analist ve intake bağlamına giriyor (M44 seam `AttachmentReader`).
 *
 * Bankanın ticket'ı "ekteki analiz dokümanına bakın" der. Bu testler üç şeyi
 * sabitler: ek metni modelin `input`'unda ticket metninin HEMEN ARDINDAN
 * gider; okunamayan ek ADIYLA gider (uydurulmaz, saklanmaz); ve seam'in her
 * arızası — yok, liste patlar, indirme patlar — analizi durdurmaz.
 */

const TXT_URL = "https://jira.internal.bank/secure/attachment/2/notlar.txt";
const PNG_URL = "https://jira.internal.bank/secure/attachment/3/ekran.png";

const META: AttachmentMeta[] = [
  { filename: "notlar.txt", mimeType: "text/plain", size: 40, contentUrl: TXT_URL },
  { filename: "ekran.png", mimeType: "image/png", size: 1000, contentUrl: PNG_URL },
];
const TXT = Buffer.from("Limit artışı skor servisinden doğrulanır.", "utf8");

function analysisInput(fakes: ReturnType<typeof makeFakes>): Record<string, unknown> {
  return fakes.recorded.llm.find((c) => c.schemaName === "analysis-doc")?.input as Record<string, unknown>;
}

describe("ticketAttachments", () => {
  it("seam yoksa boş döner ve hiçbir şey okumaz", async () => {
    const { deps } = makeFakes();
    expect(await ticketAttachments(deps, TICKET)).toEqual([]);
  });

  it("metin ekini okur, okunamayan eki adıyla ve notuyla anar", async () => {
    const { deps } = makeFakes({ attachments: { list: META, files: { [TXT_URL]: TXT, [PNG_URL]: new Uint8Array([1]) } } });
    const out = await ticketAttachments(deps, TICKET, () => undefined);
    expect(out).toEqual([
      { name: "notlar.txt", kind: "metin", text: "Limit artışı skor servisinden doğrulanır." },
      { name: "ekran.png", kind: "okunmadı", note: expect.stringContaining("image/png") },
    ]);
  });

  it("liste okuması patlarsa uyarır ve boş döner — analiz eksiz sürer", async () => {
    const warnings: string[] = [];
    const { deps } = makeFakes({ attachments: { list: new Error("jira 503") } });
    expect(await ticketAttachments(deps, TICKET, (m) => warnings.push(m))).toEqual([]);
    expect(warnings[0]).toMatch(/eklerinin listesi okunamadı/);
  });

  it("bir ekin indirmesi patlarsa o ek 'indirilemedi' notuyla kalır, diğerleri okunur", async () => {
    const { deps } = makeFakes({
      attachments: { list: META, files: { [TXT_URL]: new Error("timeout"), [PNG_URL]: new Uint8Array([1]) } },
    });
    const out = await ticketAttachments(deps, TICKET, () => undefined);
    expect(out[0]).toEqual({ name: "notlar.txt", kind: "okunmadı", note: "indirilemedi" });
    expect(out[1]?.name).toBe("ekran.png");
  });

  it("büyük dosyayı indirmez, uzun metni kısaltır, sekizden fazlasını okumaz", async () => {
    const big: AttachmentMeta = { filename: "buyuk.txt", mimeType: "text/plain", size: 9 * 1024 * 1024, contentUrl: "u://big" };
    const long: AttachmentMeta = { filename: "uzun.txt", mimeType: "text/plain", size: 10, contentUrl: "u://long" };
    const many = Array.from({ length: MAX_ATTACHMENTS + 2 }, (_, i) => ({
      filename: `n${String(i)}.txt`,
      mimeType: "text/plain",
      size: 1,
      contentUrl: `u://n${String(i)}`,
    }));
    const files: Record<string, Uint8Array> = { "u://long": Buffer.from("x".repeat(MAX_ATTACHMENT_CHARS + 500)) };
    for (const m of many) files[m.contentUrl] = Buffer.from("k");
    const warnings: string[] = [];
    const { deps } = makeFakes({ attachments: { list: [big, long, ...many], files } });
    const out = await ticketAttachments(deps, TICKET, (m) => warnings.push(m));
    expect(out).toHaveLength(MAX_ATTACHMENTS);
    expect(out[0]).toMatchObject({ name: "buyuk.txt", kind: "okunmadı", note: expect.stringContaining("çok büyük") });
    expect(out[1]?.text?.length).toBe(MAX_ATTACHMENT_CHARS);
    expect(out[1]?.note).toMatch(/kısaltıldı/);
    expect(warnings.some((w) => w.includes("ilk 8"))).toBe(true);
  });
});

describe("withAttachments (intake yolu)", () => {
  it("ek yoksa snapshot'a dokunmaz; varsa açıklamanın ardına bloğu ekler", () => {
    const snapshot = { key: TICKET, summary: "s", description: "açıklama", components: [], labels: [] } as never;
    expect(withAttachments(snapshot, [])).toBe(snapshot);
    const out = withAttachments(snapshot, [
      { name: "notlar.txt", kind: "metin", text: "satır" },
      { name: "ekran.png", kind: "okunmadı", note: "okunmuyor" },
    ]) as { description: string };
    expect(out.description).toBe(
      `açıklama\n\n${ATTACHMENT_BLOCK_TITLE}\n[ek: notlar.txt (metin)]\nsatır\n\n[ek: ekran.png (okunmadı — okunmuyor)]`,
    );
  });
});

describe("writeAnalysis ekleri modele taşır", () => {
  it("`attachments` alanı ticket metninin HEMEN ARDINDAN gider ve deftere 'ekler okundu' düşer", async () => {
    const fakes = makeFakes({
      attachments: { list: META, files: { [TXT_URL]: TXT, [PNG_URL]: new Uint8Array([1]) } },
      generateObject: () => okAnalysis(),
    });
    await writeAnalysis(fakes.deps, TICKET);
    const input = analysisInput(fakes);
    const keys = Object.keys(input);
    expect(keys.indexOf("attachments")).toBe(keys.indexOf("description") + 1);
    expect(input["attachments"]).toEqual([
      { name: "notlar.txt", kind: "metin", text: "Limit artışı skor servisinden doğrulanır." },
      { name: "ekran.png", kind: "okunmadı", note: expect.stringContaining("image/png") },
    ]);
    const entry = fakes.journalStore.entries.find((e) => e.title === "ekler okundu");
    expect(entry?.detail).toContain("notlar.txt (metin)");
    expect(entry?.detail).toContain("ekran.png (okunmadı");
  });

  it("ek yoksa alan hiç gitmez — prompt eksiz ticket için bit bit aynı", async () => {
    const fakes = makeFakes({ attachments: { list: [] }, generateObject: () => okAnalysis() });
    await writeAnalysis(fakes.deps, TICKET);
    expect("attachments" in analysisInput(fakes)).toBe(false);
    expect(fakes.journalStore.entries.some((e) => e.title === "ekler okundu")).toBe(false);
  });
});

describe("runIntake ekleri görür", () => {
  it("tamlık kontrolüne giden ticket açıklaması ek bloğunu taşır", async () => {
    const fakes = makeFakes({
      attachments: { list: [META[0]!], files: { [TXT_URL]: TXT } },
      generateObject: () => okIntake(),
    });
    await runIntake(fakes.deps, TICKET);
    const call = fakes.recorded.llm.find((c) => c.role === "intake");
    expect(JSON.stringify(call?.input)).toContain("[ek: notlar.txt (metin)]");
    expect(JSON.stringify(call?.input)).toContain("Limit artışı skor servisinden doğrulanır.");
  });
});
