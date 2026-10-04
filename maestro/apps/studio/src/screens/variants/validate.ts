/**
 * Form doğrulaması — BFF'nin `variant-service.ts`'teki sınırlarının AYNISI.
 *
 * Sınırlar burada tekrar yazılıyor, çünkü sunucu bir alanı reddettiğinde
 * cevabı tek bir genel 400 (`invalid_variant_body`): hangi alanın, neden
 * reddedildiğini söylemez. Operatör 20.000 karakterlik bir persona yapıştırıp
 * "Variant bilgisi geçersiz." okuyordu. Kural değişirse iki yer birlikte
 * değişmeli; sayılar bu yüzden tek bir tabloda.
 */
export const VARIANT_LIMITS = {
  id: 64,
  name: 64,
  model: 128,
  persona: 20_000,
  note: 500,
} as const;

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function isValidVariantId(value: string): boolean {
  const trimmed = value.trim();
  return trimmed !== "" && trimmed.length <= VARIANT_LIMITS.id && ID_PATTERN.test(trimmed);
}

export function isValidName(value: string): boolean {
  const trimmed = value.trim();
  return trimmed !== "" && trimmed.length <= VARIANT_LIMITS.name;
}

export function isValidModel(value: string): boolean {
  const trimmed = value.trim();
  return trimmed !== "" && trimmed.length <= VARIANT_LIMITS.model;
}

/** Sekme ve satır sonu dışındaki kontrol karakterleri sunucuda reddedilir. */
function hasControlChar(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const isTabOrNewline = code === 0x09 || code === 0x0a;
    if (!isTabOrNewline && (code < 0x20 || code === 0x7f)) return true;
  }
  return false;
}

export function isValidPersona(value: string): boolean {
  return value.length <= VARIANT_LIMITS.persona && !hasControlChar(value);
}

export function isValidNote(value: string): boolean {
  return value.trim().length <= VARIANT_LIMITS.note;
}
