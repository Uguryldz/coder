import { describe, expect, it } from "vitest";
import { discoverRepo } from "../src/impl/analysis.js";
import { makeFakes } from "./fakes.js";

/**
 * ── CLI KOLTUĞU OLMAYAN KURULUMDA KEŞİF ────────────────────────────────────
 *
 * Sahadan gelen şikayet: "gpt oss ile azure devops'tan kod indirip kod arama
 * yapamıyor, hatalar veriyor."
 *
 * Keşif adımı depoyu bir CLI ajan oturumunda okuyordu ve o koltuk YOKSA
 * (`CLAUDE_BIN_PATH` boş — GPT-OSS ya da başka bir HTTP modeliyle çalışan
 * kurulumların OLAĞAN hâli) `agentSession` atıyor, adım "repo keşfi
 * yapılamadı" yazıp KOD GÖRMEDEN devam ediyordu.
 *
 * Oysa kod diskte: klon zinciri o noktada çalışmış oluyor. Canlıda ölçüldü —
 * `depo-indir-test` 1630 dosya indiriyor, `mini-test` ise `spawn claude
 * ENOENT` diyor. Eksik olan tek şey dosyaları modele taşıyacak yoldu.
 */
describe("discoverRepo — CLI koltuğu yokken", () => {
  const digest = {
    tree: "DİZİN AĞACI (2 kaynak dosya):\nsrc/Ekstre.cs\nsrc/Bakiye.cs",
    files: [
      { path: "src/Ekstre.cs", text: "public class Ekstre { }" },
      { path: "src/Bakiye.cs", text: "public class Bakiye { }" },
    ],
    truncated: false,
  };

  it("reads the repository through the digest instead of giving up", async () => {
    const fakes = makeFakes({
      // agentSession KURULU DEĞİL: fake atar, tıpkı CLAUDE_BIN_PATH boşken
      // gerçek gateway'in attığı gibi.
      ensureWorkspace: () => Promise.resolve("/workspace/run-1"),
      readWorkspaceDigest: () => Promise.resolve(digest),
      generateObject: () => ({ status: "ok", value: { files: 2, modules: ["Ekstre"] }, log: null as never }),
    });

    const found = await discoverRepo(fakes.deps, "PAY-101", "Banka/ekstre-servis");

    // KİLİT: keşif BOŞ dönmüyor. Eski davranış `{ files: 0, modules: [] }`ydi.
    expect(found).toEqual({ files: 2, modules: ["Ekstre"] });
    // Ve hangi yoldan okunduğu deftere yazılıyor — iki yol karıştırılmamalı.
    const entry = fakes.journalStore.entries.find((e) => e.title === "repo CLI'sız okundu");
    expect(entry?.detail).toContain("2 dosya");
    expect(entry?.detail).toContain("kod tabanını görüyor");
    // "yapılamadı" satırı YAZILMAMALI: yapıldı.
    expect(fakes.journalStore.entries.find((e) => e.title === "repo keşfi yapılamadı")).toBeUndefined();
  });

  it("says the digest was truncated rather than pretending it read everything", async () => {
    const fakes = makeFakes({
      ensureWorkspace: () => Promise.resolve("/workspace/run-1"),
      readWorkspaceDigest: () => Promise.resolve({ ...digest, truncated: true }),
      generateObject: () => ({ status: "ok", value: { files: 2, modules: [] }, log: null as never }),
    });
    await discoverRepo(fakes.deps, "PAY-101", "Banka/ekstre-servis");
    // Kırpma SESSİZ olmaz: modelin görmediği kod, analizde olmayan koddur.
    expect(
      fakes.journalStore.entries.find((e) => e.title === "repo CLI'sız okundu")?.detail,
    ).toContain("özet kırpıldı");
  });

  /**
   * Yedek yol bir ÖRTÜ değildir: okunacak bir şey yoksa eski dürüst cevap
   * korunur. Boş bir özetle "okudum" demek, tam da düzeltilen yanılgıyı
   * üretirdi.
   */
  it("still reports failure when there is nothing to read", async () => {
    const fakes = makeFakes({
      ensureWorkspace: () => Promise.resolve("/workspace/run-1"),
      readWorkspaceDigest: () => Promise.resolve({ tree: "", files: [], truncated: false }),
    });
    expect(await discoverRepo(fakes.deps, "PAY-101", "Banka/ekstre-servis")).toEqual({ files: 0, modules: [] });
    expect(fakes.journalStore.entries.find((e) => e.title === "repo keşfi yapılamadı")).toBeTruthy();
  });

  it("behaves exactly as before when the port offers no digest at all", async () => {
    const fakes = makeFakes({ ensureWorkspace: () => Promise.resolve("/workspace/run-1") });
    expect(await discoverRepo(fakes.deps, "PAY-101", "Banka/ekstre-servis")).toEqual({ files: 0, modules: [] });
    expect(fakes.journalStore.entries.find((e) => e.title === "repo keşfi yapılamadı")).toBeTruthy();
  });
});
