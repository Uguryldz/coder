import { createHash } from "node:crypto";
import type { Locale, PublishDocKind, RunId } from "@maestro/contracts";
import { PublishRenderError } from "./errors.js";
import { MSG } from "./keys.js";
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

/** Escape markdown/HTML specials inside a single line of foreign text. */
export function escapeInline(text: string): string {
  return text.replace(/\r\n?/g, " ").replace(/\n/g, " ").replace(INLINE_SPECIALS, (c) => `\\${c}`);
}

/**
 * Multi-line foreign text: escape specials per line and defuse line-leading
 * block markers (`#`, `- `, `1.`, `>`, fences) so the text cannot open a
 * section, a list or a code block of its own.
 */
export function escapeBlock(text: string): string {
  return text
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
  md.field(label(translate, locale, MSG.metaRun), runId);
  md.field(label(translate, locale, MSG.metaTemplateVersion), templateVersion);
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
