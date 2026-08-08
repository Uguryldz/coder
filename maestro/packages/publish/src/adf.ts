import { parseMarkdown, safeHref, type Block, type Inline } from "./parse.js";

/**
 * Atlassian Document Format subset — the node set `WorkPort.addComment`
 * accepts ("ADF document or plain text"). Structural types only: this package
 * must not import the Jira adapter (M44 clean room), the two meet at the port.
 */
export type AdfMark = { type: "strong" } | { type: "code" } | { type: "link"; attrs: { href: string } };

export interface AdfText {
  type: "text";
  text: string;
  marks?: AdfMark[];
}

export interface AdfBlock {
  type: "paragraph" | "heading" | "codeBlock" | "bulletList" | "listItem";
  attrs?: Record<string, string | number>;
  content?: AdfNode[];
}

export type AdfNode = AdfText | AdfBlock;

export interface AdfDoc {
  type: "doc";
  version: 1;
  content: AdfNode[];
}

/** Markdown source → ADF document, ready for `WorkPort.addComment`. */
export function markdownToAdf(source: string): AdfDoc {
  return { type: "doc", version: 1, content: parseMarkdown(source).map(toNode) };
}

function toNode(block: Block): AdfNode {
  switch (block.kind) {
    case "heading":
      return {
        type: "heading",
        attrs: { level: Math.min(Math.max(block.level, 1), 6) },
        content: toInline(block.inline),
      };
    case "code": {
      const attrs = block.language ? { language: block.language } : undefined;
      const content = block.text.length > 0 ? [{ type: "text" as const, text: block.text }] : [];
      return { type: "codeBlock", ...(attrs ? { attrs } : {}), content };
    }
    case "list":
      // Rendered as a bullet list even when the source was numbered: the DC
      // wiki renderer has no ordered-list node in this subset, and an unknown
      // node type would flatten the items into one unreadable line. The number
      // is kept as text so nothing is lost.
      return {
        type: "bulletList",
        content: block.items.map((item, index) => ({
          type: "listItem" as const,
          content: [
            {
              type: "paragraph" as const,
              content: toInline(block.ordered ? prefixNumber(item, index + 1) : item),
            },
          ],
        })),
      };
    case "paragraph":
      return { type: "paragraph", content: toInline(block.inline) };
  }
}

function prefixNumber(inline: Inline[], number: number): Inline[] {
  return [{ kind: "text", text: `${String(number)}. ` }, ...inline];
}

function toInline(inline: Inline[]): AdfNode[] {
  const out: AdfNode[] = [];
  for (const node of inline) {
    if (node.text.length === 0) continue; // ADF forbids empty text nodes.
    switch (node.kind) {
      case "text":
        out.push({ type: "text", text: node.text });
        break;
      case "strong":
        out.push({ type: "text", text: node.text, marks: [{ type: "strong" }] });
        break;
      case "code":
        out.push({ type: "text", text: node.text, marks: [{ type: "code" }] });
        break;
      case "link": {
        const href = safeHref(node.href);
        out.push(
          href
            ? { type: "text", text: node.text, marks: [{ type: "link", attrs: { href } }] }
            : { type: "text", text: `${node.text} (${node.href})` },
        );
        break;
      }
    }
  }
  return out;
}
