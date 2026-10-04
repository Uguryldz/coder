import { LlmAuthError } from "./errors.js";

/**
 * KİMLİK REDDİ DEVRE KESİCİSİ — 403 bir ticket arızası değil, PLATFORM arızası.
 *
 * Canlıda ölçüldü (10-18 Eylül): OpenRouter anahtarı reddedildi ve sistem
 * bunu ticket başına ele aldı. Her koşu 30 kez denedi (~1 günlük merdiven),
 * insana devredildi, ertesi sabah tarama onu yeniden başlattı, 30 kez daha
 * denedi. OPS-123 altı kez, OPS-120 beş kez yeniden başlatıldı; sekiz gün
 * boyunca her sabah aynı Jira yorumu düştü ve sağlayıcı boşuna dövüldü.
 *
 * Kesicinin sorduğu soru "bu ticket kaç kez düştü" değil, "PLATFORMUN ANAHTARI
 * ÇALIŞIYOR MU". Bir 401/403 kesiciyi AÇAR: pencere boyunca her model çağrısı
 * ağa çıkmadan, anında aynı hatayla döner. Pencere dolunca TEK bir çağrı
 * yoklama olarak geçer; başarırsa kesici kapanır, yine 403 ise pencere
 * yeniden başlar.
 *
 * Süreç içi ve bilerek öyle: her süreç (bff, worker) kendi kesicisini taşır,
 * paylaşılan durum yok. Paylaşılan bir bayrak yanlış tarafta sıkışabilirdi
 * (worker "açık" der, bff kapatamaz); süreç içi kesici en fazla süreç başına
 * beş dakikada bir gerçek deneme demek — sağlayıcı için bu zaten yeterince
 * nazik.
 *
 * KESİCİ HİÇBİR ŞEYİ DEVRETMEZ. Koşu satırı `running` kalır ve Temporal'ın
 * kendi merdiveniyle (1 dk → 1 saat) bekler; anahtar düzelince bir sonraki
 * deneme geçer ve koşu kaldığı yerden sürer — yeniden başlatma yok, Jira'ya
 * ikinci "koşu başladı" yorumu yok. `guardModelCall`ın 30 denemelik devir
 * bütçesi olduğu gibi duruyor; kesici o denemeleri BEDAVA yapıyor.
 */
export const AUTH_BREAKER_WINDOW_MS = 5 * 60_000;

/** Kesici açıkken atılan hata: `LlmAuthError` ADI korunur ki tüketen kod aynı dalı seçsin. */
export class LlmAuthBreakerOpenError extends LlmAuthError {
  readonly breakerOpen = true as const;
  constructor(readonly openedAt: number, readonly retryAt: number, status: number, driver: string) {
    super(status, driver, "(devre kesici)", "");
    this.message = `${driver}: model anahtarı reddedildi, kesici açık — ağa çıkılmadı (${new Date(retryAt).toISOString()} sonrasında yeniden yoklanacak)`;
  }
}

export interface AuthBreakerState {
  readonly open: boolean;
  readonly openedAt: number | null;
  readonly retryAt: number | null;
  readonly status: number | null;
}

export class AuthBreaker {
  #openedAt: number | null = null;
  #status: number | null = null;
  #driver = "";
  #probeInFlight = false;

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly windowMs: number = AUTH_BREAKER_WINDOW_MS,
  ) {}

  state(): AuthBreakerState {
    const open = this.#openedAt !== null;
    return {
      open,
      openedAt: this.#openedAt,
      retryAt: this.#openedAt === null ? null : this.#openedAt + this.windowMs,
      status: this.#status,
    };
  }

  /**
   * Çağrıyı kesiciden geçirir.
   *
   * Açıkken ve pencere dolmamışken: ağa çıkmadan fırlatır. Pencere dolmuşsa
   * TEK bir yoklama geçer (`#probeInFlight` — eşzamanlı ikinci çağrı yine
   * kapıda bekler, yoksa pencere dolduğu an on koşu aynı anda sağlayıcıya
   * yüklenirdi).
   */
  async guard<T>(call: () => Promise<T>): Promise<T> {
    const openedAt = this.#openedAt;
    if (openedAt !== null) {
      const retryAt = openedAt + this.windowMs;
      if (this.now() < retryAt || this.#probeInFlight) {
        throw new LlmAuthBreakerOpenError(openedAt, retryAt, this.#status ?? 403, this.#driver);
      }
      this.#probeInFlight = true;
    }
    try {
      const out = await call();
      this.#openedAt = null;
      this.#status = null;
      return out;
    } catch (error) {
      if (error instanceof LlmAuthError && !(error instanceof LlmAuthBreakerOpenError)) {
        this.#openedAt = this.now();
        this.#status = error.status;
        this.#driver = error.driver;
      }
      throw error;
    } finally {
      this.#probeInFlight = false;
    }
  }
}
