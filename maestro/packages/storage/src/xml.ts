/**
 * Minimal reader for the two S3 XML payloads this package consumes:
 * ListObjectsV2 results and error bodies. A full XML parser would be a new
 * runtime dependency for ~40 lines of work, so it is done here.
 */

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};

export function decodeXmlText(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&(?:amp|lt|gt|quot|apos);/g, (entity) => ENTITIES[entity] ?? entity);
}

/** First value of a direct child element, or undefined. */
export function readTag(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(xml);
  return match?.[1] === undefined ? undefined : decodeXmlText(match[1]);
}

export interface ListObjectsPage {
  keys: string[];
  isTruncated: boolean;
  nextContinuationToken: string | undefined;
}

export function parseListObjectsV2(xml: string): ListObjectsPage {
  const keys: string[] = [];
  for (const contents of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const key = readTag(contents[1] ?? "", "Key");
    if (key !== undefined) keys.push(key);
  }
  return {
    keys,
    isTruncated: readTag(xml, "IsTruncated") === "true",
    nextContinuationToken: readTag(xml, "NextContinuationToken"),
  };
}

/** S3 error bodies carry a machine-readable `<Code>`; returns it when present. */
export function parseErrorCode(xml: string): string | undefined {
  if (!xml.includes("<Error")) return undefined;
  return readTag(xml, "Code");
}
