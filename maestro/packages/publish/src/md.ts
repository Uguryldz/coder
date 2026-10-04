import { createHash } from "node:crypto";
import type { Locale, PublishDocKind, RunId } from "@maestro/contracts";
import { PublishRenderError } from "./errors.js";
import { MSG } from "./keys.js";
// Yazan taraf okuyan tarafı çağırır ve bu tek yönlüdür: markdown'ı yeniden
// okumak `prose()`in var olma sebebi. Bir dönem ters yönde de bir kenar vardı
// (`parse.ts` buradan `stripUnsafeChars` alıyordu); ortak güvenlik süzgeci
// `unsafe-chars.ts`e çıkarıldı, döngü kalktı.
import { parseMarkdown, type Inline } from "./parse.js";
import { stripUnsafeChars } from "./unsafe-chars.js";
import type { Translate } from "./types.js";

/**
 * Markdown is the canonical form of every published document: the Jira and
 * Confluence drivers convert FROM it, repo-docs commits it verbatim. The
 * builder therefore escapes anything that came from a ticket, a model or a
 * user — an unescaped `# ` in a summary would forge a section heading.
 */
export class Markdown {
  private readonly lines: string[] = [];

  /** Raw line — only for text this package produced itself. */
  raw(line: string): this {
    this.lines.push(line);
    return this;
  }

  blank(): this {
    if (this.lines.length > 0 && this.lines[this.lines.length - 1] !== "") this.lines.push("");
    return this;
  }

  heading(level: 1 | 2 | 3, text: string): this {
    return this.blank().raw(`${"#".repeat(level)} ${escapeInline(text)}`).blank();
  }

  paragraph(text: string): this {
    return this.blank().raw(escapeBlock(text)).blank();
  }

  /**
   * Model-authored prose, with its markdown STRUCTURE kept.
   *
   * `paragraph()` escapes every `**` and every line-leading `-`, which is right
   * for a ticket summary — nothing a requester types may forge a heading. It is
   * wrong for a section the model wrote: the model emits markdown whether or not
   * the prompt asks for it, and escaping it published `**UI Değişiklikleri:** -
   * Mobil ... - Limit ...` as one run-together paragraph with the asterisks
   * printed. That reached a bank reviewer.
   *
   * So the text is READ first (`parseMarkdown`, the same reader every driver
   * uses) and re-emitted as canonical markdown, with each piece of foreign text
   * escaped individually. The security property is unchanged — a `#` inside a
   * bullet is still escaped and cannot open a section — while a bullet the model
   * wrote stays a bullet in Word, in the PDF, on Confluence and in Jira.
   *
   * Structure that survives: `**bold**`, `- `/`* ` bullets (nested included),
   * `1.` ordered lists, and sub-headings. Blank items are dropped rather than
   * printed as a bare `•`.
   */
  prose(text: string): this {
    const blocks = parseMarkdown(text);
    // Nothing structural in it: the plain path still handles the common case,
    // and keeps its escaping for text that only LOOKS like a marker.
    if (blocks.every((b) => b.kind === "paragraph")) return this.paragraph(text);

    this.blank();
    for (const block of blocks) {
      switch (block.kind) {
        case "heading":
          // Re-levelled: a `#` the model wrote inside section 5 is a SUB-heading
          // of section 5, never a peer of it. `##` is the document's own section
          // level, so model headings start one below at `###`.
          this.raw(`### ${inlineToMarkdown(block.inline)}`).blank();
          break;
        case "paragraph":
          this.raw(inlineToMarkdown(block.inline)).blank();
          break;
        case "list": {
          for (const [index, item] of block.items.entries()) {
            const rendered = inlineToMarkdown(item);
            // The blank bullet: `- ` with nothing after it parses to an empty
            // item and printed a bare `•` in the middle of the risk section.
            if (rendered.trim().length === 0) continue;
            this.raw(block.ordered ? `${String(index + 1)}. ${rendered}` : `- ${rendered}`);
          }
          this.blank();
          break;
        }
        case "code":
          this.raw("```").raw(stripUnsafeChars(block.text)).raw("```").blank();
          break;
      }
    }
    return this.blank();
  }

  /** `- **label:** value` — the document's key/value line. */
  field(label: string, value: string): this {
    return this.raw(`- **${escapeInline(label)}:** ${escapeInline(value)}`);
  }

  bullets(items: string[], emptyLabel?: string): this {
    this.blank();
    if (items.length === 0) {
      if (emptyLabel !== undefined) this.raw(`- ${escapeInline(emptyLabel)}`);
      return this.blank();
    }
    for (const item of items) this.raw(`- ${escapeInline(item)}`);
    return this.blank();
  }

  toString(): string {
    // Collapse the leading/trailing blanks the block helpers add; a document
    // must render byte-identically every time it is built (idempotency).
    return `${this.lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
  }
}

const INLINE_SPECIALS = /[\\`*_[\]<>|]/g;

/**
 * Güvensiz karakter süzgeci `unsafe-chars.ts`te yaşıyor; buradan yeniden
 * dışavuruluyor çünkü çağıranlar onu tarihsel olarak bu modülden alıyor.
 */
export { stripUnsafeChars };

/** Escape markdown/HTML specials inside a single line of foreign text. */
export function escapeInline(text: string): string {
  return stripUnsafeChars(text)
    .replace(/\r\n?/g, " ")
    .replace(/\n/g, " ")
    .replace(INLINE_SPECIALS, (c) => `\\${c}`);
}

/**
 * Multi-line foreign text: escape specials per line and defuse line-leading
 * block markers (`#`, `- `, `1.`, `>`, fences) so the text cannot open a
 * section, a list or a code block of its own.
 */
export function escapeBlock(text: string): string {
  return stripUnsafeChars(text)
    .split(/\r\n?|\n/)
    .map((line) => {
      const escaped = line.replace(INLINE_SPECIALS, (c) => `\\${c}`);
      return escaped.replace(/^(\s*)([#+~=-]|\d+[.)])(\s|$)/, (_m, indent: string, marker: string, tail: string) =>
        `${indent}\\${marker}${tail}`,
      );
    })
    .join("\n");
}

/**
 * Inline runs back to markdown, with the TEXT escaped but the MARKUP kept.
 *
 * This is the half of `prose()` that makes re-emitting safe: `**` around a bold
 * run is ours (we produced it by parsing), so it is written literally, while
 * everything inside it came from a model and is escaped. A model that writes
 * `**a ** b**` therefore gets one bold run and no stray emphasis, and one that
 * writes `# ` inside a bullet gets a printed `#` rather than a new section.
 */
function inlineToMarkdown(inline: readonly Inline[]): string {
  return inline
    .map((run) => {
      switch (run.kind) {
        case "strong":
          return `**${escapeInline(run.text)}**`;
        case "code":
          // Backticks are stripped, not escaped: an escaped backtick inside a
          // code span would be printed by every renderer downstream.
          return `\`${stripUnsafeChars(run.text).replace(/`/g, "")}\``;
        case "link":
          return `[${escapeInline(run.text)}](${stripUnsafeChars(run.href).replace(/[\s()<>"]/g, "")})`;
        default:
          return escapeInline(run.text);
      }
    })
    .join("");
}

/**
 * Document header (M83): the pinned template version travels INSIDE the
 * document, so an audit reading a Confluence page or a committed file can tell
 * which standard it was written against without asking the database.
 *
 * Deliberately no generation timestamp: a rendered document must be a pure
 * function of its input, otherwise republishing the same analysis produces a
 * different byte string and every idempotency check downstream fails.
 */
export function documentHeader(args: {
  translate: Translate;
  locale: Locale;
  kind: PublishDocKind;
  titleKey: string;
  runId: RunId;
  ticketKey: string;
  templateVersion: string;
}): Markdown {
  const { translate, locale, titleKey, runId, ticketKey, templateVersion } = args;
  const md = new Markdown();
  md.raw(`<!-- maestro:doc kind=${args.kind} run=${sanitizeMarker(runId)} template=${sanitizeMarker(templateVersion)} -->`);
  md.heading(1, label(translate, locale, titleKey, { ticket: ticketKey }));
  md.field(label(translate, locale, MSG.metaTicket), ticketKey);
  md.field(label(translate, locale, MSG.metaTemplateVersion), templateVersion);
  // The run id is NOT a header field. It is an internal workflow handle
  // (`maestro-OPS-66`), and printing it as "Akış: maestro-OPS-66" above the
  // analysis told a bank reviewer nothing they can act on while implying the
  // document is about a pipeline rather than about a change. It still travels
  // in the `maestro:doc` marker on the line above, which is where the audit
  // trail reads it from — so nothing is lost, it simply stops being furniture.
  md.blank();
  return md;
}

/** `-->` inside a marker value would close the comment early. */
function sanitizeMarker(value: string): string {
  return value.replace(/[^A-Za-z0-9._@+:-]/g, "");
}

/**
 * Catalog lookup, fail-closed: an empty translation would publish a heading-less
 * document to a bank's Confluence instead of failing where it can be fixed.
 */
export function label(
  translate: Translate,
  locale: Locale,
  key: string,
  params?: Record<string, string>,
): string {
  const value = translate(locale, key, params);
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PublishRenderError(`message key "${key}" resolved to an empty string for locale "${locale}"`);
  }
  return value;
}

/** Content fingerprint used by every driver's idempotency check. */
export function contentHash(markdownSource: string): string {
  return createHash("sha256").update(markdownSource, "utf8").digest("hex");
}
