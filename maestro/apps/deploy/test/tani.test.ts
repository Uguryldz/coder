import { describe, expect, it } from "vitest";
import {
  dikkatMi,
  gurultuMu,
  html,
  logAyikla,
  maskeleSatir,
  ozetle,
  taniHtml,
  type TaniRaporu,
} from "../src/tani.js";

/**
 * The diagnostic page's pure half.
 *
 * Everything asserted here is something the tool can get SILENTLY wrong — a
 * page that renders, reads plausibly, and is false. A secret that survives
 * masking leaves the building on a page written to be sent to someone. A noise
 * filter that swallows the one error line reproduces the exact failure this
 * whole tool exists to end. A summary that reports zero critical findings on a
 * broken install tells the operator to look somewhere else.
 */

/** The masker the bin wires in: `URL`-structural, from `@maestro/bff`. */
const maskUrl = (dsn: string): string => {
  try {
    const url = new URL(dsn);
    if (url.password === "") return dsn;
    url.password = "***";
    return url.toString();
  } catch {
    return "(set; unreadable form withheld)";
  }
};
const maskele = (satir: string): string => maskeleSatir(satir, maskUrl);

describe("maskeleSatir: nothing secret leaves the building", () => {
  it("masks the password inside a connection URL, keeping the host readable", () => {
    // The host IS the diagnosis ("which database is this pointed at"); the
    // password never is.
    const out = maskele("DATABASE_URL=postgresql://maestro:s3cr3tP@ss@postgres:5432/maestro");
    expect(out).not.toContain("s3cr3t");
    expect(out).toContain("postgres");
  });

  it("masks a bearer token but keeps the fact that a header was sent", () => {
    // "Was a credential sent at all" is a real diagnostic question; its value
    // is not.
    const out = maskele('GET /rest/api/2/myself Authorization: Bearer NjAxMjM0NTY3ODkwYWJjZGVm');
    expect(out).not.toContain("NjAxMjM0NTY3ODkwYWJjZGVm");
    expect(out).toContain("Bearer ***");
  });

  it("keeps the auth SCHEME while masking its value — the scheme is the diagnosis", () => {
    // `Bearer` means a Data Center PAT, `Basic` a Cloud email:token pair, and
    // the wrong one is precisely what a 401 is telling you. An over-eager
    // second masking pass erased it.
    expect(maskele("Authorization: Basic bWFpbEBiYW5rYS5sb2NhbDp0b2tlbg==")).toContain("Basic ***");
  });

  it("masks a suffixed variable name — the shape real .env files use", () => {
    // `\bsecret` matches nothing in `JIRA_WEBHOOK_SECRET`, because `_` is a word
    // character. The names most likely to leak were exactly the ones escaping.
    for (const satir of [
      "JIRA_WEBHOOK_SECRET=topsecretvalue",
      "LLM_API_KEY=sk-abcdef123456",
      "POSTGRES_PASSWORD=hunter2000",
    ]) {
      const out = maskele(satir);
      expect(out, satir).toContain("***");
      expect(out.split("=")[1], satir).toBe("***");
    }
  });

  it("masks named secret fields in both key=value and JSON form", () => {
    expect(maskele("token=abc123def456")).not.toContain("abc123def456");
    expect(maskele('{"password":"hunter2000"}')).not.toContain("hunter2000");
    expect(maskele("JIRA_WEBHOOK_SECRET=topsecretvalue")).not.toContain("topsecretvalue");
  });

  it("leaves diagnostic identifiers alone — a hash is not a secret", () => {
    // The narrow-pattern rule, asserted. A masker that ate commit hashes and
    // container ids would make the page unreadable, and an unreadable report is
    // an unsent report.
    const satir = "container 3f9a1c2b8e77 started, commit a1b2c3d4e5f6a7b8c9d0";
    expect(maskele(satir)).toBe(satir);
  });

  it("does not mangle a URL that carries no userinfo", () => {
    const satir = "GET https://jira.banka.local/rest/api/2/search?jql=order+by+created";
    expect(maskele(satir)).toContain("jira.banka.local");
  });
});

describe("gurultuMu: what the page refuses to drown in", () => {
  it("hides the three families that actually flooded a real report", () => {
    expect(gurultuMu("2026-08-30 10:00:00 LOG:  checkpoint starting: time")).toBe(true);
    expect(gurultuMu("2026-08-30 10:05:00 LOG:  checkpoint complete: wrote 42 buffers")).toBe(true);
    expect(gurultuMu('{"logging-call-at":"matchingEngine.go:812","msg":"lifecycle"}')).toBe(true);
    expect(gurultuMu('10.0.0.5 - - [30/Aug/2026:10:00:00] "GET /api/health HTTP/1.1" 200 512 "-"')).toBe(true);
  });

  it("KEEPS an nginx line that did not return 2xx — those are the diagnosis", () => {
    expect(gurultuMu('10.0.0.5 - - [30/Aug/2026:10:00:00] "GET /api/runs HTTP/1.1" 502 0 "-"')).toBe(false);
  });

  it("keeps an ordinary application line", () => {
    expect(gurultuMu('{"level":30,"msg":"[maestro] bff listening on 0.0.0.0:7001"}')).toBe(false);
  });
});

describe("dikkatMi: the lines pulled to the top", () => {
  it("catches structured pino levels and plain-text severities alike", () => {
    // Two log grammars flow through this one stack; a single pattern would miss
    // one of them.
    expect(dikkatMi('{"level":50,"msg":"jira call failed"}')).toBe(true);
    expect(dikkatMi('{"level":40,"msg":"[dinleme] UYARI: ..."}')).toBe(true);
    expect(dikkatMi("2026-08-30 10:00:00 ERROR:  relation does not exist")).toBe(true);
  });

  it("catches a REFUSAL, which is how this stack usually fails", () => {
    // The common shape of trouble here is not an exception but a rejection:
    // Jira answers 401, the model server refuses the connection. Neither
    // carries the word "Error:".
    expect(dikkatMi("connect ECONNREFUSED 10.0.0.9:8000")).toBe(true);
    expect(dikkatMi("Jira GET /rest/api/2/myself: unauthorized (PAT invalid or expired)")).toBe(true);
    expect(dikkatMi('"GET /api/runs HTTP/1.1" 503')).toBe(true);
  });

  it("leaves a healthy line alone", () => {
    expect(dikkatMi('{"level":30,"msg":"[keşif] tur bitti: 0 yeni"}')).toBe(false);
  });
});

describe("logAyikla: filtering that says what it hid", () => {
  it("counts the noise instead of silently dropping it", () => {
    // A dropped line becomes, one day, the line being looked for. Saying how
    // many were dropped is what makes the omission recoverable.
    const ham = [
      "LOG:  checkpoint starting: time",
      "LOG:  checkpoint complete: wrote 1 buffers",
      '{"level":50,"msg":"boom"}',
      "",
    ];
    const { log, dikkat } = logAyikla("postgres", ham, maskele);
    expect(log.gizlenen).toBe(2);
    expect(log.satirlar).toHaveLength(1);
    expect(dikkat).toHaveLength(1);
    expect(dikkat[0]?.servis).toBe("postgres");
  });

  it("masks BEFORE deciding a line is noteworthy, so the highlight is safe too", () => {
    // The error summary is the most-read block on the page; a secret that
    // survived into it would be the most-read secret.
    const { dikkat } = logAyikla("bff", ["ERROR: auth failed, token=supersecret123"], maskele);
    expect(dikkat[0]?.satir).not.toContain("supersecret123");
  });
});

describe("html: a log line may not become markup", () => {
  it("escapes ampersand first, so its own output is not re-escaped", () => {
    expect(html("a & b")).toBe("a &amp; b");
    expect(html("<script>alert(1)</script>")).not.toContain("<script>");
  });
});

/** A report with one critical finding and one healthy one. */
function ornekRapor(): TaniRaporu {
  return {
    kunye: {
      uretimZamani: "2026-08-31 12:00:00",
      hostAdi: "banka-app-01",
      imajSurumu: "maestro/node:1.0.13",
      satirSayisi: 200,
    },
    yapilandirma: {
      bulgular: [
        { baslik: "Bot kimliği", seviye: "kritik", sonuc: "Kimlik yok.", cozum: "Panelden test edin." },
        { baslik: "Jira iş sürücüsü", seviye: "iyi", sonuc: "jira-dc" },
        { baslik: "Statü haritası", seviye: "uyari", sonuc: "Yok." },
      ],
    },
    akis: {
      toplam: 3,
      adimDagilimi: [["2b", 1] as const, ["6a", 2] as const],
      netlestirmeBekleyen: [
        { id: "run-1", ticketKey: "ABC-1", step: "2b", status: "gate", updatedAt: "2026-08-30 09:00:00" },
      ],
      sonKosular: [
        { id: "run-1", ticketKey: "ABC-1", step: "2b", status: "gate", updatedAt: "2026-08-30 09:00:00" },
      ],
      temporalAcik: 1,
    },
    jira: {
      denemeler: [
        { ad: "getTicket", durum: "basarili", aciklama: "ABC-1 okundu." },
        { ad: "searchIssues (JQL)", durum: "basarisiz", httpKodu: 401, aciklama: "unauthorized" },
      ],
    },
    log: {
      servisler: [{ servis: "bff", satirlar: ['{"level":50,"msg":"boom"}'], gizlenen: 1240 }],
      dikkat: [{ servis: "bff", satir: '{"level":50,"msg":"boom"}' }],
    },
  };
}

describe("ozetle: the verdict at the top of the page", () => {
  it("counts by severity and calls the install broken when anything is critical", () => {
    const ozet = ozetle(ornekRapor());
    expect(ozet).toMatchObject({ kritik: 1, uyari: 1, iyi: 1, calisir: false });
  });

  it("judges on CONFIGURATION only — an old error line does not condemn the install", () => {
    // Mixing "is it configured" with "did anything ever fail" would paint every
    // real deployment red and the page would stop being read.
    const rapor = ornekRapor();
    const temiz: TaniRaporu = {
      ...rapor,
      yapilandirma: { bulgular: [{ baslik: "x", seviye: "iyi", sonuc: "ok" }] },
    };
    expect(ozetle(temiz).calisir).toBe(true);
    expect(temiz.log.dikkat.length).toBeGreaterThan(0);
  });
});

describe("taniHtml: one self-contained page", () => {
  const sayfa = taniHtml(ornekRapor());

  it("loads NOTHING from the network — the bank has no internet", () => {
    // A CDN reference fails silently on an air-gapped host: the page opens,
    // unstyled, and the operator concludes the tool is broken.
    expect(sayfa).not.toMatch(/<link[^>]+href=["']https?:/i);
    expect(sayfa).not.toMatch(/<script[^>]+src=/i);
    expect(sayfa).not.toMatch(/@import\s+url\(/i);
    expect(sayfa).toContain("<style>");
  });

  it("puts the identity block at the top: when, where, which image", () => {
    expect(sayfa).toContain("banka-app-01");
    expect(sayfa).toContain("maestro/node:1.0.13");
    expect(sayfa).toContain("2026-08-31 12:00:00");
  });

  it("leads with the critical finding and its fix", () => {
    const kritikYeri = sayfa.indexOf("Bot kimliği");
    const uyariYeri = sayfa.indexOf("Statü haritası");
    expect(kritikYeri).toBeGreaterThan(-1);
    expect(kritikYeri).toBeLessThan(uyariYeri);
    expect(sayfa).toContain("Panelden test edin.");
  });

  it("names how many noise lines it hid", () => {
    expect(sayfa).toContain("1240 gürültü satırı gizlendi");
  });

  it("shows the 2b queue separately — the runs waiting on a human answer", () => {
    expect(sayfa).toContain("2b'de bekleyen koşular");
  });

  it("says out loud that no transition was applied", () => {
    // The page is the tool's own claim about its blast radius, and an operator
    // running this on a live bank needs to read it there.
    expect(sayfa).toContain("UYGULANMADI");
  });

  it("wraps long log lines instead of letting them overflow", () => {
    expect(sayfa).toContain("white-space: pre-wrap");
    expect(sayfa).toContain("overflow-wrap: anywhere");
  });

  it("folds each service log but opens the error summary", () => {
    expect(sayfa).toContain("<details>");
    // The dikkat block is rendered outside any <details>.
    const dikkatYeri = sayfa.indexOf("Hata ve uyarı satırları");
    const detaylarYeri = sayfa.indexOf("Servis bazında tam log");
    expect(dikkatYeri).toBeLessThan(detaylarYeri);
  });

  it("expands every folded section when printed", () => {
    expect(sayfa).toContain("@media print");
    expect(sayfa).toContain("details > div { display: block !important; }");
  });

  it("escapes content that arrived from an untrusted log", () => {
    const kotu = ornekRapor();
    const zehirli: TaniRaporu = {
      ...kotu,
      log: {
        servisler: [{ servis: "bff", satirlar: ["<img src=x onerror=alert(1)>"], gizlenen: 0 }],
        dikkat: [],
      },
    };
    const cikti = taniHtml(zehirli);
    expect(cikti).not.toContain("<img src=x");
    expect(cikti).toContain("&lt;img src=x");
  });
});
