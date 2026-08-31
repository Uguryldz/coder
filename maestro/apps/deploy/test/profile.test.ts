import { GITHUB_DRIVER_ID } from "@maestro/adapter-github";
import { JIRA_DC_DRIVER, WORK_PORT } from "@maestro/adapter-jira";
import { LLM_GATEWAY_DRIVER, LLM_PORT } from "@maestro/llm-gateway";
import { NOTIFY_PORT } from "@maestro/notify";
import { PUBLISH_PORT } from "@maestro/publish";
import { SCAN_PORT } from "@maestro/scanners";
import { ENV_FILE_DRIVER, SECRET_PORT, VAULT_DRIVER } from "@maestro/secrets";
import { PG_BLOB_DRIVER, S3_DRIVER, STORAGE_PORT } from "@maestro/storage";
import { PORT_NAMES } from "@maestro/workflows";
import { describe, expect, it } from "vitest";
import {
  ALL_PORT_KEYS,
  assertProfileComplete,
  driversFor,
  NOT_CONFIGURED_DRIVER,
  parseProfile,
  PROFILE_DRIVERS,
  PROFILES,
  ProfileError,
  WORKER_PORT_KEYS,
  jiraUrlLooksLikeCloud,
  jiraUrlMatchesDriver,
  type DriverMap,
} from "../src/profile.js";

/**
 * Pinning tests.
 *
 * `profile.ts` names ports and drivers as string literals so that naming one
 * does not drag its package into the composition root's import graph. That is
 * the right trade, but it means a rename in a driver package would leave the
 * profile pointing at a driver nobody registers — and the failure would be a
 * runtime "no driver X for port Y", in a container, at boot.
 *
 * These tests are the other half of the trade: they import the constants (in a
 * TEST, where the coupling costs nothing) and assert the literals still match.
 */

describe("port names match the worker's", () => {
  it("covers exactly the keys `PortSelection` requires", () => {
    expect([...WORKER_PORT_KEYS].sort()).toEqual(Object.keys(PORT_NAMES).sort());
  });

  it("adds `ci` and nothing else on top of them", () => {
    const extra = ALL_PORT_KEYS.filter((key) => !WORKER_PORT_KEYS.includes(key as never));
    expect(extra).toEqual(["ci"]);
  });
});

describe("port name literals match the packages that register them", () => {
  it.each([
    ["work", WORK_PORT],
    ["llm", LLM_PORT],
    ["scan", SCAN_PORT],
    ["storage", STORAGE_PORT],
    ["secret", SECRET_PORT],
    ["notify", NOTIFY_PORT],
    ["publish", PUBLISH_PORT],
  ])("%s", (key, exported) => {
    expect(PORT_NAMES[key as keyof typeof PORT_NAMES]).toBe(exported);
  });
});

describe("driver id literals match the packages that export them", () => {
  it("work → jira-dc", () => {
    expect(driversFor("prod").work).toBe(JIRA_DC_DRIVER);
    expect(driversFor("dev").work).toBe(JIRA_DC_DRIVER);
  });

  /**
   * The pin that matters most since Dalga E: `scm` is a REAL driver in every
   * profile, and it is the one `@maestro/adapter-github` actually registers.
   *
   * The literal here is what stops the old failure from coming back in a new
   * shape. A profile pointing `scm` at a driver nobody registers would compose
   * to nothing, and the symptom would be identical to the one this change
   * removed: a wizard offering "Hata düzeltme" and a run dying at the
   * engineering step.
   */
  it("scm → github, in every profile", () => {
    for (const profile of PROFILES) {
      expect(driversFor(profile).scm).toBe(GITHUB_DRIVER_ID);
    }
  });

  it("llm → gateway", () => {
    expect(driversFor("prod").llm).toBe(LLM_GATEWAY_DRIVER);
  });

  it("secret → vault in prod, env-file in dev", () => {
    expect(driversFor("prod").secret).toBe(VAULT_DRIVER);
    expect(driversFor("dev").secret).toBe(ENV_FILE_DRIVER);
  });

  it("storage → s3-compat in prod, pg-blob in dev", () => {
    expect(driversFor("prod").storage).toBe(S3_DRIVER);
    expect(driversFor("dev").storage).toBe(PG_BLOB_DRIVER);
  });
});

describe("profiles are complete", () => {
  it.each(Object.keys(PROFILE_DRIVERS))("%s names a driver for every port", (profile) => {
    const drivers = PROFILE_DRIVERS[profile as keyof typeof PROFILE_DRIVERS];
    expect(() => assertProfileComplete(drivers, profile)).not.toThrow();
    for (const key of ALL_PORT_KEYS) {
      expect(drivers[key], `${profile}.${key}`).toBeTruthy();
    }
  });

  it("refuses a map with a port left undefined, naming the port", () => {
    const holed = { ...driversFor("dev"), storage: undefined } as unknown as DriverMap;
    expect(() => assertProfileComplete(holed, "dev")).toThrow(/storage/);
  });

  it("refuses a blank driver name rather than resolving it", () => {
    const blank = { ...driversFor("dev"), notify: "  " } as DriverMap;
    expect(() => assertProfileComplete(blank, "dev")).toThrow(ProfileError);
  });

  it("never selects the dev-only drivers in the prod profile", () => {
    const prod = driversFor("prod");
    expect(prod.secret).not.toBe(ENV_FILE_DRIVER);
    expect(prod.storage).not.toBe(PG_BLOB_DRIVER);
  });
});

/**
 * The regression this whole change exists to prevent.
 *
 * A deployment used to be able to answer "no, this install does not write
 * code", and it answered by wiring `scm` to a driver that refused. Everything
 * upstream — the wizard's "Hata düzeltme" option, the listening rule, the
 * approved analysis — was already committed by the time anything discovered it.
 *
 * These pin the boundary rather than the wiring: a profile may still choose
 * where secrets and blobs live, because those are facts of the machine. It may
 * not choose whether the product has an engineering half.
 */
describe("a profile decides infrastructure, never capability", () => {
  it("gives every profile a real scm driver, so none can disable the code path", () => {
    for (const profile of PROFILES) {
      const scm = driversFor(profile).scm;
      expect(scm, `${profile}.scm`).toBe(GITHUB_DRIVER_ID);
      // The specific shape of the old bug: a refusing driver in the scm slot.
      expect(scm, `${profile}.scm`).not.toBe(NOT_CONFIGURED_DRIVER);
    }
  });

  it("still lets a profile choose where secrets and blobs live", () => {
    // The line between the two kinds of decision. Nobody picks Vault from a web
    // form, so this half stays a deploy-time answer — and the profiles must
    // therefore still DIFFER on it, or the distinction has been lost.
    expect(driversFor("prod").secret).not.toBe(driversFor("dev").secret);
    expect(driversFor("prod").storage).not.toBe(driversFor("dev").storage);
  });

  it("offers no profile whose name promises a capability", () => {
    // `analiz` was a profile named after what a run DOES. That is the category
    // error: a run's purpose is per-ticket (`ListeningRule.flowType`), and a
    // profile that encodes it can only ever contradict the rule an operator
    // wrote. Profiles name environments now, and nothing else.
    expect([...PROFILES]).toEqual(["prod", "dev"]);
  });
});

describe("parseProfile", () => {
  it.each(["prod", "dev"])("accepts %s", (name) => {
    expect(parseProfile(name)).toBe(name);
  });

  it("refuses an unknown name and lists the real ones", () => {
    expect(() => parseProfile("staging")).toThrow(/prod, dev/);
  });

  it("refuses an unset profile rather than guessing", () => {
    expect(() => parseProfile(undefined)).toThrow(ProfileError);
  });
});

/**
 * Adres ile sürücünün çelişkisi — bir bankada saatler yakan sessiz-yanlışın
 * testi.
 *
 * Sürücü seçimi adresin İÇİNE bakmaz (bakmamalı da: seçen şey hangi değişkenin
 * dolu olduğudur), ve tam o kör noktada bir Data Center adresi
 * `JIRA_CLOUD_BASE_URL` satırına yazılınca sistem Cloud protokolüyle DC'ye
 * gidiyor, hiçbir yerde hata görünmüyordu. Buradaki heuristik o çelişkiyi
 * adlandırır — reddetmez, çünkü yanılabilir.
 */
describe("jiraUrlLooksLikeCloud", () => {
  it.each([
    "https://banka.atlassian.net",
    "https://banka.atlassian.net/",
    "https://banka.atlassian.net/jira/software",
    // Büyük harf: konak adı büyük/küçük harf duyarsızdır.
    "https://BANKA.ATLASSIAN.NET",
    // Şemasız yazım — `.env` dosyalarında sık.
    "banka.atlassian.net",
    // Eski, nadir ama gerçek Atlassian barındırma alanı.
    "https://banka.jira.com",
    // Mutlak DNS adı yazımı: aynı konak.
    "https://banka.atlassian.net.",
    // Çıplak hâl: bir örnek adresi değil ama Atlassian'ındır, uyarı üretmesin.
    "https://atlassian.net",
  ])("Cloud olarak tanır: %s", (url) => {
    expect(jiraUrlLooksLikeCloud(url)).toBe(true);
  });

  it.each([
    // Bankayı yakan tam da bu satırdı.
    "https://jira.banka.local",
    // Port: `hostname` onu düşürür, ama iç ağ adı yine iç ağ adıdır.
    "https://jira.banka.local:8443",
    "jira.banka.local:8080",
    "https://10.20.30.40:8080",
    "https://jira.banka.corp/browse",
    "https://jira.banka.intra",
    // Sonek TAKLİDİ: sonun sonuna bakıldığı için elenir.
    "https://evil-atlassian.net.banka.local",
    // `atlassian.net` bir ALT dize olarak geçiyor ama konak adı o değil.
    "https://atlassian.net.banka.local",
    // Boş ve boşluk: okunacak adres yok → "Cloud'a benziyor" DEMEYİZ.
    "",
    "   ",
    // Ayrıştırılamayan çöp.
    "http://",
    ":::",
  ])("Cloud saymaz: %s", (url) => {
    expect(jiraUrlLooksLikeCloud(url)).toBe(false);
  });

  it("boşlukları kırpar — .env satırları sondaki boşlukla gelebilir", () => {
    expect(jiraUrlLooksLikeCloud("  https://banka.atlassian.net  ")).toBe(true);
  });
});

describe("jiraUrlMatchesDriver", () => {
  it("Cloud değişkeninde iç ağ adresi bir ÇELİŞKİdir", () => {
    expect(jiraUrlMatchesDriver({ JIRA_CLOUD_BASE_URL: "https://jira.banka.local" })).toBe(
      false,
    );
  });

  it("Cloud değişkeninde gerçek bir Cloud adresi çelişki değildir", () => {
    expect(jiraUrlMatchesDriver({ JIRA_CLOUD_BASE_URL: "https://banka.atlassian.net" })).toBe(
      true,
    );
  });

  it("ters yön de aynı hatadır: DC değişkeninde bir Cloud adresi", () => {
    expect(jiraUrlMatchesDriver({ JIRA_BASE_URL: "https://banka.atlassian.net" })).toBe(false);
  });

  it("DC değişkeninde iç ağ adresi beklenen hâldir", () => {
    expect(jiraUrlMatchesDriver({ JIRA_BASE_URL: "https://jira.banka.local:8443" })).toBe(true);
  });

  it("hiç adres yoksa soru anlamsızdır — null, false değil", () => {
    // `false` bir ÇELİŞKİ iddiasıdır ve kurulmamış bir yığında yanlış olurdu:
    // orada söylenecek söz zaten "yapılandırılmamış" satırının kendisi.
    expect(jiraUrlMatchesDriver({})).toBeNull();
  });

  it("ikisi birden doluysa null — o açılış zaten adıyla reddediliyor", () => {
    expect(
      jiraUrlMatchesDriver({
        JIRA_BASE_URL: "https://jira.banka.local",
        JIRA_CLOUD_BASE_URL: "https://banka.atlassian.net",
      }),
    ).toBeNull();
  });
});
