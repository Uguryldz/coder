import { describe, expect, it } from "vitest";
import { resolveBotIdentity } from "../src/bot-identity.js";
import type { ConnectionRecord, ConnectionStore } from "../src/connection-store.js";

/**
 * Motorun Jira kimliğinin ÇÖZÜLMESİ.
 *
 * Kapatılan boşluk: yeniden giriş yalnız `MAESTRO_BOT_ACCOUNT_ID`'yi okuyordu,
 * ama kurulum sırası o değeri boş bırakmayı açıkça onaylıyor ("kimlik panelden,
 * bağlantı testinde öğrenilecek"). Sonuç: kurulum yeşil biter, bağlantı testi
 * kimliği öğrenir, ve netleştirme döngüsü yine de hiç çalışmaz — hiçbir yerde
 * hata görünmeden.
 *
 * Buradaki testlerin ASIL işi düşüşün SINIRINI çivilemek. Bağlantı kimliğine
 * körlemesine düşmek güvenli değil: `engineIdentityWarning` ikisinin
 * ayrışabileceğini uyarıyor ve yanlış kimlik, yankı korumasının 1. katmanını
 * deler. Düşüş bu yüzden yalnızca .env BOŞKEN yapılıyor — ayrışmanın tanımı
 * gereği mümkün olmadığı tek durum.
 */

const jira = (config: Record<string, string>, over: Partial<ConnectionRecord> = {}) =>
  ({
    id: "conn-1",
    kind: "jira_dc",
    enabled: true,
    baseUrl: "https://jira.kurum.local",
    secretRef: "kv/jira#token",
    config,
    ...over,
  }) as unknown as ConnectionRecord;

const store = (...records: ConnectionRecord[]): ConnectionStore =>
  ({ list: () => Promise.resolve(records) }) as unknown as ConnectionStore;

describe("resolveBotIdentity", () => {
  it("prefers the written env value and never reads a connection for it", async () => {
    let listed = false;
    const spy = {
      list: () => {
        listed = true;
        return Promise.resolve([jira({ botAccountId: "baglanti-kimligi" })]);
      },
    } as unknown as ConnectionStore;

    expect(await resolveBotIdentity("motor-kimligi", spy)).toEqual({
      accountId: "motor-kimligi",
      source: "env",
    });
    // Ayrışma durumuna DOKUNULMUYOR: yazılı değer varsa öğrenilmiş değer hiç
    // sorulmaz, dolayısıyla bu değişiklik `engineIdentityWarning`'in uyardığı
    // hâli değiştiremez.
    expect(listed).toBe(false);
  });

  it("falls back to the identity the connection test learned when env is empty", async () => {
    expect(await resolveBotIdentity("", store(jira({ botAccountId: "maestro.bot" })))).toEqual({
      accountId: "maestro.bot",
      source: "connection",
    });
  });

  // Boş/beyaz .env, "yapılandırılmamış"tır — bir kimlik değil.
  it("treats a whitespace-only env value as unconfigured", async () => {
    expect(await resolveBotIdentity("   ", store(jira({ botAccountId: "maestro.bot" })))).toEqual({
      accountId: "maestro.bot",
      source: "connection",
    });
  });

  it("ignores a connection that was never tested, rather than inventing an identity", async () => {
    expect(await resolveBotIdentity("", store(jira({})))).toBeNull();
    expect(await resolveBotIdentity("", store(jira({ botAccountId: "  " })))).toBeNull();
  });

  // Devre dışı bir bağlantı bir kaynak değil: kuralları tohumlayan seçim de
  // (`listening-seed.ts`) yalnız açık olanlara bakıyor, ve ikisinin ayrışması
  // ticket'ın bir kimlikle girip başka bir kimlikle uyandırılmayı beklemesi
  // demek olurdu.
  it("skips disabled and non-Jira connections", async () => {
    const disabled = jira({ botAccountId: "eski.bot" }, { enabled: false });
    const notJira = jira({ botAccountId: "github.bot" }, { kind: "github" });
    expect(await resolveBotIdentity("", store(disabled, notJira))).toBeNull();
    expect(await resolveBotIdentity("", store(disabled, notJira, jira({ botAccountId: "yeni.bot" })))).toEqual({
      accountId: "yeni.bot",
      source: "connection",
    });
  });

  it("reports nothing rather than throwing when the connection store is unwired or fails", async () => {
    expect(await resolveBotIdentity("", undefined)).toBeNull();
    // Fırlatmak webhook yolunda 5xx demek olurdu ve Jira teslimatı yeniden
    // gönderirdi (M14) — okunamayan bir tablo bir teslimat fırtınası sebebi olamaz.
    const broken = { list: () => Promise.reject(new Error("db down")) } as unknown as ConnectionStore;
    expect(await resolveBotIdentity("", broken)).toBeNull();
  });
});
