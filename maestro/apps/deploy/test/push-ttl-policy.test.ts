import { describe, expect, it } from "vitest";
import * as ado from "@maestro/adapter-ado";
import * as github from "@maestro/adapter-github";
import { EXPIRY_SKEW_SECONDS } from "@maestro/ports";

/**
 * M31 — İKİ SÜRÜCÜ AYNI TAVANI UYGULAR.
 *
 * Bu politika bir dönem iki dosyada birebir kopya olarak yaşıyordu. Kopya
 * kendiliğinden zararsızdı; tehlikeli olan, birinde sıkılaştırılan bir
 * güvenlik kuralının ötekinde sessizce eski hâlinde kalmasıydı — o taraf
 * sınırsız bir push jetonu basmaya devam ederdi. Kopya `@maestro/ports`ta tek
 * kaynağa indirildi; bu test o birleşmenin BOZULMADIĞINI ölçer.
 *
 * Her sürücünün kendi hata SINIFI vardır (ADO/GitHub ayrı hata tipleri) ve
 * kendi scope ÖNEKİ vardır; ayrışması gereken tek şey bunlardır. Reddedilen
 * ve kabul edilen girdi kümesi ayrışamaz.
 */

const DRIVERS = [
  { name: "ado", mod: ado, scopePrefix: "ado/" },
  { name: "github", mod: github, scopePrefix: "github/" },
] as const;

const CEILING = 900;

/** Reddedilmesi gereken TTL istekleri — hiçbir sürücü bunları basmamalı. */
const REJECTED_TTLS = [0, -1, 1.5, Number.NaN, CEILING + 1, 86_400 * 365 * 10];
/** Kabul edilmesi gereken TTL istekleri. */
const ACCEPTED_TTLS = [1, 60, CEILING];

describe("M31 push TTL politikası iki sürücüde aynıdır", () => {
  for (const ttl of REJECTED_TTLS) {
    it(`ttl=${ttl} her iki sürücüde de reddedilir`, () => {
      for (const { name, mod } of DRIVERS) {
        expect(() => mod.assertTtlWithinCeiling(ttl, CEILING), name).toThrow();
      }
    });
  }

  for (const ttl of ACCEPTED_TTLS) {
    it(`ttl=${ttl} her iki sürücüde de kabul edilir`, () => {
      for (const { name, mod } of DRIVERS) {
        expect(() => mod.assertTtlWithinCeiling(ttl, CEILING), name).not.toThrow();
      }
    });
  }

  it("hata sınıfları AYRIŞIR — birleşen politika, sürücünün hata tipini yutmaz", () => {
    const thrown = DRIVERS.map(({ mod }) => {
      try {
        mod.assertTtlWithinCeiling(CEILING + 1, CEILING);
        return null;
      } catch (error) {
        return error as Error;
      }
    });
    expect(thrown[0]).not.toBeNull();
    expect(thrown[1]).not.toBeNull();
    expect(thrown[0]!.constructor).not.toBe(thrown[1]!.constructor);
    // Ama ikisi de AYNI sebebi söyler.
    for (const error of thrown) {
      expect(error!.message).toContain(String(CEILING));
    }
  });

  it("scope önekleri AYRIŞIR — iki sürücünün sırrı aynı kovaya yazılmaz", () => {
    const repo = { project: "banka", repo: "odeme" } as never;
    const scopes = DRIVERS.map(({ mod }) => mod.pushScope(repo));
    expect(scopes[0]).toBe("ado/banka/odeme/push");
    expect(scopes[1]).toBe("github/banka/odeme/push");
    expect(new Set(scopes).size).toBe(DRIVERS.length);
  });
});

describe("basılan kimlik bilgisi denetimi iki sürücüde aynıdır", () => {
  const NOW = Date.parse("2026-09-14T12:00:00.000Z");
  const TTL = 600;
  const iso = (offsetSeconds: number): string => new Date(NOW + offsetSeconds * 1000).toISOString();

  const CASES: ReadonlyArray<{
    readonly what: string;
    readonly issued: { secret: string; expiresAt: string } | undefined;
    readonly ok: boolean;
  }> = [
    { what: "pencere içinde ölen jeton", issued: { secret: "s", expiresAt: iso(TTL - 1) }, ok: true },
    { what: "tam kayma sınırında ölen jeton", issued: { secret: "s", expiresAt: iso(TTL + EXPIRY_SKEW_SECONDS) }, ok: true },
    { what: "kaymayı bir saniye aşan jeton", issued: { secret: "s", expiresAt: iso(TTL + EXPIRY_SKEW_SECONDS + 1) }, ok: false },
    { what: "çoktan ölmüş jeton", issued: { secret: "s", expiresAt: iso(-1) }, ok: false },
    { what: "boş sır", issued: { secret: "", expiresAt: iso(TTL - 1) }, ok: false },
    { what: "ISO olmayan son kullanma", issued: { secret: "s", expiresAt: "yarın" }, ok: false },
    { what: "hiç basılmamış", issued: undefined, ok: false },
    { what: "yıllarca yaşayan PAT", issued: { secret: "s", expiresAt: iso(86_400 * 365) }, ok: false },
  ];

  for (const { what, issued, ok } of CASES) {
    it(`${what} → ${ok ? "geçer" : "reddedilir"}, iki sürücüde de aynı`, () => {
      const results = DRIVERS.map(({ mod }) => mod.issuedCredentialIssues(issued, TTL, NOW));
      for (const issues of results) {
        expect(issues.length === 0).toBe(ok);
      }
      // Yalnız "reddedilir/geçer" değil, GEREKÇE de aynı olmalı: iki sürücü
      // aynı girdiye farklı sebep söylüyorsa politika yeniden ayrışmış demektir.
      expect(results[0]).toEqual(results[1]);
    });
  }

  it("kayma sabiti tek kaynaktan gelir", () => {
    for (const { name, mod } of DRIVERS) {
      expect(mod.EXPIRY_SKEW_SECONDS, name).toBe(EXPIRY_SKEW_SECONDS);
    }
  });
});
