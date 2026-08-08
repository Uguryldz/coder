import { JiraResponseError } from "./errors.js";

/**
 * Minimal Atlassian Document Format model — just the node set analysis and
 * gate comments need (M75). ADF is our canonical in-core comment format; the
 * DC wire format is wiki markup, so `adfToWikiMarkup` renders on the way out
 * (M46: "wiki-markup/ADF differences follow DC"). A future Cloud driver posts
 * the same document verbatim to REST v3.
 */

export type AdfMark = { type: "strong" } | { type: "code" } | { type: "link"; attrs: { href: string } };

export interface AdfText {
  type: "text";
  text: string;
  marks?: AdfMark[];
}

export interface AdfBlock {
  type: "paragraph" | "heading" | "codeBlock" | "panel" | "bulletList" | "listItem";
  attrs?: Record<string, string | number>;
  content?: AdfNode[];
}

export type AdfNode = AdfText | AdfBlock;

export interface AdfDoc {
  type: "doc";
  version: 1;
  content: AdfNode[];
}

export type PanelType = "info" | "note" | "warning" | "success" | "error";

export function text(value: string, marks?: AdfMark[]): AdfText {
  return marks && marks.length > 0 ? { type: "text", text: value, marks } : { type: "text", text: value };
}

export function strong(value: string): AdfText {
  return text(value, [{ type: "strong" }]);
}

export function inlineCode(value: string): AdfText {
  return text(value, [{ type: "code" }]);
}

export function link(label: string, href: string): AdfText {
  return text(label, [{ type: "link", attrs: { href } }]);
}

/** `paragraph("plain")` or `paragraph([strong("bold"), text(" rest")])`. */
export function paragraph(content: string | AdfNode[]): AdfBlock {
  return { type: "paragraph", content: typeof content === "string" ? [text(content)] : content };
}

export function heading(level: 1 | 2 | 3 | 4 | 5 | 6, value: string): AdfBlock {
  return { type: "heading", attrs: { level }, content: [text(value)] };
}

export function codeBlock(value: string, language?: string): AdfBlock {
  return {
    type: "codeBlock",
    ...(language ? { attrs: { language } } : {}),
    content: [text(value)],
  };
}

export function panel(panelType: PanelType, content: AdfNode[]): AdfBlock {
  return { type: "panel", attrs: { panelType }, content };
}

/** Acceptance criteria / impact lists in analysis comments. */
export function bulletList(items: (string | AdfNode[])[]): AdfBlock {
  return {
    type: "bulletList",
    content: items.map((item) => ({ type: "listItem", content: [paragraph(item)] }) satisfies AdfBlock),
  };
}

export function doc(...content: AdfNode[]): AdfDoc {
  return { type: "doc", version: 1, content };
}

/** True for `{ type: "doc", content: [...] }` — the shape callers may hand us. */
export function isAdfDoc(value: unknown): value is AdfDoc {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { type?: unknown; content?: unknown };
  return candidate.type === "doc" && Array.isArray(candidate.content);
}

/**
 * Accept what WorkPort.addComment accepts: an ADF document, or a plain string
 * that gets wrapped into paragraphs (blank line = new paragraph).
 */
export function toAdfDocument(body: unknown): AdfDoc {
  if (isAdfDoc(body)) return { type: "doc", version: 1, content: body.content };
  if (typeof body === "string") {
    const blocks = body
      .split(/\n{2,}/)
      .map((block) => block.trim())
      .filter((block) => block.length > 0)
      .map((block) => paragraph(block));
    return doc(...(blocks.length > 0 ? blocks : [paragraph("")]));
  }
  throw new JiraResponseError("comment body", ["expected an ADF document or a plain string"]);
}

/**
 * Render ADF to Jira wiki markup, the only rich format REST v2 (DC) accepts.
 * Unknown node types degrade to their plain text rather than throwing — a
 * comment must never be lost because of a decoration we do not model.
 */
export function adfToWikiMarkup(document: AdfDoc): string {
  return document.content
    .map((node) => renderBlock(node, 0))
    .filter((block) => block.length > 0)
    .join("\n\n");
}

function renderBlock(node: AdfNode, depth: number): string {
  if (node.type === "text") return renderInline([node]);

  // Widened on purpose: a document may carry node types we do not model, and
  // the default branch must stay reachable so they degrade to plain text.
  switch (node.type as string) {
    case "paragraph":
      return renderInline(node.content ?? []);
    case "heading": {
      const level = typeof node.attrs?.["level"] === "number" ? node.attrs["level"] : 2;
      return `h${level}. ${renderInline(node.content ?? [])}`;
    }
    case "codeBlock": {
      const language = node.attrs?.["language"];
      const open = typeof language === "string" && language.length > 0 ? `{code:${language}}` : "{code}";
      return `${open}\n${renderInline(node.content ?? [])}\n{code}`;
    }
    case "panel": {
      const panelType = node.attrs?.["panelType"];
      const open = typeof panelType === "string" ? `{panel:bgColor=${PANEL_COLORS[panelType] ?? PANEL_COLORS["info"]}}` : "{panel}";
      const inner = (node.content ?? [])
        .map((child) => renderBlock(child, depth + 1))
        .filter((child) => child.length > 0)
        .join("\n");
      return `${open}\n${inner}\n{panel}`;
    }
    case "bulletList": {
      const bullet = "*".repeat(depth + 1);
      return (node.content ?? [])
        .map((item) => `${bullet} ${renderBlock(item, depth + 1)}`)
        .join("\n");
    }
    case "listItem":
      return (node.content ?? [])
        .map((child) => renderBlock(child, depth))
        .filter((child) => child.length > 0)
        .join(" ");
    default:
      return renderInline(node.content ?? []);
  }
}

const PANEL_COLORS: Record<string, string> = {
  info: "#deebff",
  note: "#eae6ff",
  warning: "#fffae6",
  success: "#e3fcef",
  error: "#ffebe6",
};

function renderInline(nodes: AdfNode[]): string {
  return nodes
    .map((node) => {
      if (node.type !== "text") return renderBlock(node, 0);
      let out = node.text;
      for (const mark of node.marks ?? []) {
        if (mark.type === "strong") out = `*${out}*`;
        else if (mark.type === "code") out = `{{${out}}}`;
        else if (mark.type === "link") out = `[${out}|${mark.attrs.href}]`;
      }
      return out;
    })
    .join("");
}
