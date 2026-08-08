import type { Detector, PiiMatch } from "../types.js";

/**
 * 11 digits, not starting with 0, not glued to another alphanumeric. The
 * lookarounds keep an 11-digit run inside a longer number or inside an IBAN
 * from being offered as a candidate at all.
 */
const TCKN_RE = /(?<![0-9A-Za-z])[1-9][0-9]{10}(?![0-9A-Za-z])/g;

/**
 * T.C. Kimlik Numarası checksum. Both check digits are mandatory: an
 * arbitrary 11-digit run (an order id, a timestamp) must not be masked, or
 * the model loses information it legitimately needs.
 *
 * d10 = ((d1+d3+d5+d7+d9) * 7 - (d2+d4+d6+d8)) mod 10
 * d11 = (d1 + ... + d10) mod 10
 */
export function isValidTckn(value: string): boolean {
  if (!/^[1-9][0-9]{10}$/.test(value)) return false;
  let odd = 0;
  let even = 0;
  let firstTen = 0;
  for (let i = 0; i < 10; i += 1) {
    const digit = value.charCodeAt(i) - 48;
    firstTen += digit;
    if (i < 9) {
      if (i % 2 === 0) odd += digit;
      else even += digit;
    }
  }
  const tenth = (((odd * 7 - even) % 10) + 10) % 10;
  if (tenth !== value.charCodeAt(9) - 48) return false;
  return firstTen % 10 === value.charCodeAt(10) - 48;
}

export const tcknDetector: Detector = {
  type: "tckn",
  scan(text: string): PiiMatch[] {
    const matches: PiiMatch[] = [];
    for (const m of text.matchAll(TCKN_RE)) {
      const value = m[0];
      if (m.index === undefined || !isValidTckn(value)) continue;
      matches.push({
        type: "tckn",
        start: m.index,
        end: m.index + value.length,
        text: value,
        canonical: value,
      });
    }
    return matches;
  },
};
