import type { Detector, PiiMatch } from "../types.js";

/**
 * Deliberately narrower than RFC 5322: a local part, an `@`, and a dotted
 * domain with a real TLD label. Quoted local parts and IP-literal domains are
 * not worth the false positives they bring in Jira prose.
 */
const EMAIL_RE =
  /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+(?![A-Za-z0-9-])/g;

export const emailDetector: Detector = {
  type: "email",
  scan(text: string): PiiMatch[] {
    const matches: PiiMatch[] = [];
    for (const m of text.matchAll(EMAIL_RE)) {
      const raw = m[0];
      if (m.index === undefined) continue;
      matches.push({
        type: "email",
        start: m.index,
        end: m.index + raw.length,
        text: raw,
        // Case is not significant for identity; `Ali@x.com` and `ali@x.com`
        // share a token so the model sees one person, not two.
        canonical: raw.toLowerCase(),
      });
    }
    return matches;
  },
};
