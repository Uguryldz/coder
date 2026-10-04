import { describe, expect, it } from "vitest";
import { AUTH_BREAKER_WINDOW_MS, AuthBreaker, LlmAuthBreakerOpenError } from "../src/breaker.js";
import { LlmAuthError } from "../src/errors.js";

/**
 * 403 bir ticket arızası değil, PLATFORM arızası.
 *
 * Canlıda ölçüldü: anahtar reddedilince her koşu 30 kez denedi, devredildi,
 * ertesi sabah yeniden başlatıldı, 30 kez daha denedi. Sekiz gün, beş ticket.
 * Kesicinin işi bu denemeleri BEDAVA yapmak: bir 403 pencereyi açar, pencere
 * boyunca hiçbir çağrı ağa çıkmaz, pencere sonunda TEK yoklama geçer.
 */
function clock(start = 1_000_000): { now: () => number; tick: (ms: number) => void } {
  let t = start;
  return { now: () => t, tick: (ms) => void (t += ms) };
}
const reject = (): Promise<never> =>
  Promise.reject(new LlmAuthError(403, "openai-compat", "https://x/v1/chat", "forbidden"));

describe("AuthBreaker", () => {
  it("kapalıyken çağrı olduğu gibi geçer", async () => {
    const b = new AuthBreaker(clock().now);
    expect(await b.guard(() => Promise.resolve("ok"))).toBe("ok");
    expect(b.state().open).toBe(false);
  });

  it("bir 403 kesiciyi AÇAR — sonraki çağrı ağa çıkmadan aynı adla düşer", async () => {
    const c = clock();
    const b = new AuthBreaker(c.now);
    await expect(b.guard(reject)).rejects.toThrow(LlmAuthError);
    expect(b.state().open).toBe(true);

    let dialed = false;
    await expect(
      b.guard(() => {
        dialed = true;
        return Promise.resolve("asla");
      }),
    ).rejects.toSatisfy((e: unknown) => e instanceof LlmAuthBreakerOpenError && e.name === "LlmAuthError");
    expect(dialed, "kesici açıkken ağa çıkılmamalı").toBe(false);
  });

  it("pencere dolunca TEK yoklama geçer; başarırsa kesici kapanır", async () => {
    const c = clock();
    const b = new AuthBreaker(c.now);
    await expect(b.guard(reject)).rejects.toThrow();
    c.tick(AUTH_BREAKER_WINDOW_MS + 1);
    expect(await b.guard(() => Promise.resolve("düzeldi"))).toBe("düzeldi");
    expect(b.state().open).toBe(false);
  });

  it("yoklama yine 403 ise pencere YENİDEN başlar", async () => {
    const c = clock();
    const b = new AuthBreaker(c.now);
    await expect(b.guard(reject)).rejects.toThrow();
    c.tick(AUTH_BREAKER_WINDOW_MS + 1);
    await expect(b.guard(reject)).rejects.toThrow(LlmAuthError);
    const s = b.state();
    expect(s.open).toBe(true);
    expect(s.openedAt).toBe(c.now());
  });

  it("eşzamanlı ikinci çağrı yoklamaya KATILMAZ — pencere dolduğunda on koşu birden sağlayıcıya yüklenmez", async () => {
    const c = clock();
    const b = new AuthBreaker(c.now);
    await expect(b.guard(reject)).rejects.toThrow();
    c.tick(AUTH_BREAKER_WINDOW_MS + 1);
    let release!: () => void;
    const probe = b.guard(() => new Promise<string>((r) => (release = () => r("ok"))));
    // Yoklama uçuştayken ikinci çağrı kapıda düşer.
    await expect(b.guard(() => Promise.resolve("ikinci"))).rejects.toThrow(LlmAuthBreakerOpenError);
    release();
    expect(await probe).toBe("ok");
  });

  it("403 dışı hata kesiciyi AÇMAZ", async () => {
    const b = new AuthBreaker(clock().now);
    await expect(b.guard(() => Promise.reject(new Error("ağ koptu")))).rejects.toThrow("ağ koptu");
    expect(b.state().open).toBe(false);
  });

  it("açık hata pencerenin ne zaman dolacağını SÖYLER", async () => {
    const c = clock();
    const b = new AuthBreaker(c.now);
    await expect(b.guard(reject)).rejects.toThrow();
    try {
      await b.guard(() => Promise.resolve());
    } catch (e) {
      expect((e as LlmAuthBreakerOpenError).retryAt).toBe(c.now() + AUTH_BREAKER_WINDOW_MS);
      expect((e as LlmAuthBreakerOpenError).breakerOpen).toBe(true);
    }
  });
});
