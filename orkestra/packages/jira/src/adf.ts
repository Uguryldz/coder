/**
 * Atlassian Document Format (ADF) helpers.
 *
 * Builds a subset of ADF nodes we need for rich comments posted by the
 * workflow. See https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/
 */

export interface AdfMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface AdfNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
  text?: string;
  marks?: AdfMark[];
}

export interface AdfDoc extends AdfNode {
  type: "doc";
  version: 1;
  content: AdfNode[];
}

// ---------------------------------------------------------------------------
// Atoms
// ---------------------------------------------------------------------------

export function doc(...content: AdfNode[]): AdfDoc {
  return { type: "doc", version: 1, content };
}

export function text(value: string, marks?: AdfMark[]): AdfNode {
  const node: AdfNode = { type: "text", text: value };
  if (marks && marks.length > 0) node.marks = marks;
  return node;
}

export function strong(value: string): AdfNode {
  return text(value, [{ type: "strong" }]);
}

export function em(value: string): AdfNode {
  return text(value, [{ type: "em" }]);
}

export function code(value: string): AdfNode {
  return text(value, [{ type: "code" }]);
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

export function paragraph(...content: Array<AdfNode | string>): AdfNode {
  return {
    type: "paragraph",
    content: content.map((c) => (typeof c === "string" ? text(c) : c)),
  };
}

export function heading(level: 1 | 2 | 3 | 4 | 5 | 6, content: string | AdfNode[]): AdfNode {
  return {
    type: "heading",
    attrs: { level },
    content: typeof content === "string" ? [text(content)] : content,
  };
}

export function codeBlock(source: string, language?: string): AdfNode {
  return {
    type: "codeBlock",
    attrs: language ? { language } : undefined,
    content: [text(source)],
  };
}

export function bulletList(items: Array<string | AdfNode | AdfNode[]>): AdfNode {
  return {
    type: "bulletList",
    content: items.map((item) => ({
      type: "listItem",
      content: typeof item === "string" ? [paragraph(item)] : Array.isArray(item) ? item : [item],
    })),
  };
}

export function orderedList(items: Array<string | AdfNode | AdfNode[]>): AdfNode {
  return {
    type: "orderedList",
    content: items.map((item) => ({
      type: "listItem",
      content: typeof item === "string" ? [paragraph(item)] : Array.isArray(item) ? item : [item],
    })),
  };
}

/** Minimal table builder. Rows[0] may be a header row. */
export function table(rows: Array<Array<string | AdfNode>>, opts?: { header?: boolean }): AdfNode {
  const header = opts?.header ?? false;
  const tableRows = rows.map((row, idx) => ({
    type: "tableRow",
    content: row.map((cell) => ({
      type: header && idx === 0 ? "tableHeader" : "tableCell",
      content: [typeof cell === "string" ? paragraph(cell) : cell],
    })),
  }));
  return { type: "table", content: tableRows };
}

/**
 * Render a hyperlink ("button" affordance). ADF has no real button mark on
 * classic comments; we use a bold link as the visual affordance.
 */
export function button(label: string, href: string): AdfNode {
  return text(label, [{ type: "link", attrs: { href } }, { type: "strong" }]);
}

export function link(label: string, href: string): AdfNode {
  return text(label, [{ type: "link", attrs: { href } }]);
}

export function rule(): AdfNode {
  return { type: "rule" };
}

// ---------------------------------------------------------------------------
// High-level renderers
// ---------------------------------------------------------------------------

export interface AcceptanceCriterion {
  text: string;
}

export interface TechDesignLike {
  approach: string;
  filesToChange: Array<{ path: string; action: string; rationale?: string }>;
  alternatives?: string[];
  migrations?: string[];
  infraChanges?: string[];
}

/**
 * Render the analyst's output (analysis, tech design, acceptance criteria)
 * as a single ADF document suitable for a Jira comment.
 */
export function renderAnalysis(
  analysisDoc: string,
  techDesign: TechDesignLike,
  criteria: Array<string | AcceptanceCriterion>,
): AdfDoc {
  const fileRows: Array<Array<string>> = [["Path", "Action", "Rationale"]];
  for (const f of techDesign.filesToChange) {
    fileRows.push([f.path, f.action, f.rationale ?? ""]);
  }

  const sections: AdfNode[] = [
    heading(2, "AI Analysis"),
    ...splitParagraphs(analysisDoc),
    heading(2, "Technical Design"),
    paragraph(strong("Approach: "), text(techDesign.approach)),
  ];

  if (techDesign.filesToChange.length > 0) {
    sections.push(heading(3, "Files to change"), table(fileRows, { header: true }));
  }
  if (techDesign.alternatives && techDesign.alternatives.length > 0) {
    sections.push(heading(3, "Alternatives considered"), bulletList(techDesign.alternatives));
  }
  if (techDesign.migrations && techDesign.migrations.length > 0) {
    sections.push(heading(3, "Migrations"), bulletList(techDesign.migrations));
  }
  if (techDesign.infraChanges && techDesign.infraChanges.length > 0) {
    sections.push(heading(3, "Infra changes"), bulletList(techDesign.infraChanges));
  }

  sections.push(
    heading(2, "Acceptance Criteria"),
    bulletList(criteria.map((c) => (typeof c === "string" ? c : c.text))),
  );

  return doc(...sections);
}

export interface SummaryCardCommand {
  label: string;
  command: string; // e.g. "/approve"
}

/**
 * Render a compact status summary card for the current workflow step.
 * The `[Detay]` link is a placeholder; callers should pass an absolute URL
 * to the Studio run detail page when available.
 */
export function renderSummaryCard(
  step: string,
  assignees: string[],
  slaHoursLeft: number | null,
  commands: SummaryCardCommand[],
  detailUrl?: string,
): AdfDoc {
  const metaRows: Array<Array<string>> = [
    ["Step", step],
    ["Assignees", assignees.length > 0 ? assignees.join(", ") : "—"],
    ["SLA", slaHoursLeft === null ? "n/a" : `${slaHoursLeft}h left`],
  ];

  const cmdItems: AdfNode[] = commands.map((c) =>
    paragraph(strong(c.label), text(" — "), code(c.command)),
  );

  const sections: AdfNode[] = [heading(3, "Orkestra — current step"), table(metaRows)];

  if (cmdItems.length > 0) {
    sections.push(heading(4, "Available commands"), ...cmdItems);
  }

  sections.push(paragraph(button("[Detay]", detailUrl ?? "about:blank")));

  return doc(...sections);
}

function splitParagraphs(src: string): AdfNode[] {
  return src
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => paragraph(p));
}
