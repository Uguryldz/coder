import type { Locale } from "@maestro/contracts";
import { TEMPLATE_MSG } from "./doc-template.js";
import { label } from "./md.js";
import { parseMarkdown, type Block, type Inline } from "./parse.js";
import type { Translate } from "./types.js";

/**
 * The document model both binary drivers render from (M103r).
 *
 * `renderAnalysisMarkdown` already produces the canonical markdown, and the
 * Jira/Confluence drivers convert from it. The `.docx` and `.pdf` drivers do
 * the same rather than re-deriving structure from `AnalysisDoc`: one document,
 * one text, whatever the target. A section that only exists in the Word output
 * is a section no reviewer approved on the Confluence page.
 *
 * What this module adds on top of `parseMarkdown` is the SHAPE the reference
 * standard asks for (plan/referans/DOKUMAN-STANDARDI.md): an imprint (künye)
 * table under the title, and numbered top-level sections.
 */

/** The künye — the reference document's single-row identity block. */
export interface Imprint {
  readonly preparedBy: string;
  readonly date: string;
  readonly version: string;
  readonly ticket: string;
  /** Label/value pairs, already translated, in display order. */
  readonly rows: readonly (readonly [string, string])[];
}

export interface DocSection {
  /** "1", "2", … — top-level only; deeper headings keep their own numbering. */
  readonly number: string;
  readonly title: string;
  readonly blocks: readonly Block[];
}

export interface DocumentModel {
  readonly title: string;
  readonly imprint: Imprint;
  readonly sections: readonly DocSection[];
  /** Blocks before the first `##` heading (rarely used; never dropped). */
  readonly preamble: readonly Block[];
}

export interface BuildModelArgs {
  markdownSource: string;
  translate: Translate;
  locale: Locale;
  ticketKey: string;
  runId: string;
  templateVersion: string;
  /** Generation date for the künye; injected so output stays deterministic. */
  date: string;
}

/**
 * Split the canonical markdown into title + numbered sections.
 *
 * The `# ` heading is the document title and the `- **field:** value` lines the
 * header builder emits directly under it are metadata, not content: they are
 * lifted into the künye table instead of being repeated as a bullet list, which
 * is exactly the difference between the reference PDF and a printed markdown
 * file.
 */
export function buildDocumentModel(args: BuildModelArgs): DocumentModel {
  const blocks = parseMarkdown(args.markdownSource);
  const { translate: tr, locale } = args;

  let title = "";
  const preamble: Block[] = [];
  const sections: DocSection[] = [];
  let current: { number: string; title: string; blocks: Block[] } | null = null;

  for (const block of blocks) {
    if (block.kind === "heading" && block.level === 1 && title === "") {
      title = plainText(block.inline);
      continue;
    }
    if (block.kind === "heading" && block.level === 2) {
      if (current) sections.push(freeze(current));
      current = { number: String(sections.length + 1), title: plainText(block.inline), blocks: [] };
      continue;
    }
    if (current) current.blocks.push(block);
    else preamble.push(block);
  }
  if (current) sections.push(freeze(current));

  // The metadata bullets live in the preamble; the künye consumes them so they
  // are not printed twice.
  const { rows, rest } = liftImprintRows(preamble);

  return {
    title,
    imprint: {
      preparedBy: label(tr, locale, TEMPLATE_MSG.preparedByMaestro),
      date: args.date,
      version: args.templateVersion,
      ticket: args.ticketKey,
      rows: [
        [label(tr, locale, TEMPLATE_MSG.imprintPreparedBy), label(tr, locale, TEMPLATE_MSG.preparedByMaestro)],
        [label(tr, locale, TEMPLATE_MSG.imprintDate), args.date],
        [label(tr, locale, TEMPLATE_MSG.imprintVersion), args.templateVersion],
        [label(tr, locale, TEMPLATE_MSG.imprintTicket), args.ticketKey],
        ...rows,
      ],
    },
    sections,
    preamble: rest,
  };
}

function freeze(section: { number: string; title: string; blocks: Block[] }): DocSection {
  return { number: section.number, title: section.title, blocks: section.blocks };
}

/**
 * Pull `- **Label:** value` lines out of the preamble into künye rows.
 *
 * Only leading metadata is lifted: a list further down is body content. The
 * markdown writer escapes foreign text, so the label is matched on the bold
 * run rather than on a raw `**` scan.
 */
function liftImprintRows(blocks: readonly Block[]): {
  rows: (readonly [string, string])[];
  rest: Block[];
} {
  const rows: (readonly [string, string])[] = [];
  const rest: Block[] = [];
  let stillLeading = true;

  for (const block of blocks) {
    if (stillLeading && block.kind === "list" && !block.ordered) {
      const pairs = block.items.map(asFieldPair);
      if (pairs.every((pair) => pair !== null)) {
        for (const pair of pairs) if (pair) rows.push(pair);
        continue;
      }
    }
    stillLeading = false;
    rest.push(block);
  }
  return { rows, rest };
}

/** `**Label:** value` → `["Label", "value"]`, or null when it is not one. */
function asFieldPair(inline: readonly Inline[]): readonly [string, string] | null {
  const first = inline[0];
  if (first?.kind !== "strong") return null;
  const key = first.text.replace(/:\s*$/, "").trim();
  const value = plainText(inline.slice(1)).replace(/^[:\s]+/, "").trim();
  if (key.length === 0 || value.length === 0) return null;
  return [key, value];
}

/** Flatten inline runs to plain text — headings and table cells need it. */
export function plainText(inline: readonly Inline[]): string {
  return inline.map((run) => run.text).join("");
}
