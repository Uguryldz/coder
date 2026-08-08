import { LivingSummary, type JournalEntry } from "@maestro/contracts";
import { MemoryArgumentError } from "./errors.js";
import type { JournalMasker } from "./masking.js";
import { clip, digestLine, entryLine } from "./summary-format.js";

/** `contracts.LivingSummary.text` is capped at 8000 characters (M30). */
export const SUMMARY_MAX_CHARS = 8000;
export const DEFAULT_RECENT_COUNT = 12;
export const DEFAULT_LINE_CHARS = 200;
/** Below this a summary cannot carry its guaranteed sections. */
const MIN_MAX_CHARS = 400;

/**
 * Kinds whose newest entry *is* the current state of that concern, so an
 * older one of the same kind is superseded rather than lost.
 *
 * The frozen `JournalEntry` has no status field, so "still open" cannot be
 * read off a single entry. Rather than invent a resolution protocol on top of
 * a frozen contract, memory uses the one rule the journal does support: the
 * latest scan result is the scan result, the latest CI verdict is the CI
 * verdict. Those latest entries are the "open findings" the summary always
 * keeps.
 */
export const FINDING_KINDS = [
  "scan",
  "review",
  "test_review",
  "ci",
  "pii",
  "quota",
  "handover",
] as const;

const FINDING_KIND_SET: ReadonlySet<string> = new Set(FINDING_KINDS);

export interface SummaryOptions {
  /** Newest events kept verbatim. Default 12. */
  readonly recentCount?: number;
  /** Hard ceiling, never above 8000. */
  readonly maxChars?: number;
  /** Per-line clip. Default 200. */
  readonly lineChars?: number;
  /**
   * Optional runtime re-check that nothing unmasked reached the summary.
   * Entries that came out of `appendJournal` are masked already; this is for
   * callers that assembled entries some other way (M82).
   */
  readonly guard?: Pick<JournalMasker, "assertClean">;
}

interface Level {
  readonly mode: "full" | "sections";
  readonly recent: number;
  readonly gates: number;
  readonly earlier: "full" | "digest" | "none";
  readonly lineChars: number;
}

/**
 * Degradation ladder. Rendering is attempted at each level in order and the
 * first result that fits the budget wins, which keeps the whole thing a pure
 * function of the journal: same entries in, same characters out.
 *
 * What is given up, in order: the full older log, then older gate lines, then
 * line width. The newest events, the newest gate decisions and the open
 * findings survive every level — that is the retention rule of M30.
 */
function ladder(recent: number, lineChars: number): Level[] {
  const half = Math.max(3, Math.floor(recent / 2));
  return [
    { mode: "full", recent, gates: Infinity, earlier: "full", lineChars },
    { mode: "sections", recent, gates: Infinity, earlier: "digest", lineChars },
    { mode: "sections", recent: half, gates: 12, earlier: "digest", lineChars },
    { mode: "sections", recent: 3, gates: 6, earlier: "digest", lineChars: 120 },
    { mode: "sections", recent: 3, gates: 3, earlier: "none", lineChars: 80 },
    { mode: "sections", recent: 1, gates: 1, earlier: "none", lineChars: 60 },
  ];
}

/** Sorted copy; rejects the two shapes that would make a summary a lie. */
function normalise(runId: string, entries: readonly JournalEntry[]): JournalEntry[] {
  const sorted = [...entries].sort((a, b) => a.seq - b.seq);
  const seen = new Set<number>();
  for (const entry of sorted) {
    if (entry.runId !== runId) {
      throw new MemoryArgumentError("living summary", `entry #${entry.seq} belongs to ${entry.runId}, not ${runId}`);
    }
    if (seen.has(entry.seq)) {
      throw new MemoryArgumentError("living summary", `duplicate journal seq #${entry.seq}`);
    }
    seen.add(entry.seq);
  }
  return sorted;
}

function header(runId: string, entries: readonly JournalEntry[]): string[] {
  const first = entries[0];
  const last = entries[entries.length - 1];
  if (first === undefined || last === undefined) {
    return [`run ${runId} · journal empty`];
  }
  return [
    `run ${runId} · journal #${first.seq}-#${last.seq} (${entries.length} entries)`,
    `window ${first.at} → ${last.at}`,
  ];
}

function render(runId: string, entries: readonly JournalEntry[], level: Level): string {
  const lines = header(runId, entries);
  if (entries.length === 0) return lines.join("\n");

  if (level.mode === "full") {
    lines.push("", "## log");
    for (const entry of entries) lines.push(entryLine(entry, level.lineChars));
    return lines.join("\n");
  }

  const recentFrom = Math.max(0, entries.length - level.recent);
  const recent = entries.slice(recentFrom);
  const older = entries.slice(0, recentFrom);

  // Latest entry per finding kind; those already in `recent` are not repeated.
  const latestFinding = new Map<string, JournalEntry>();
  for (const entry of entries) {
    if (FINDING_KIND_SET.has(entry.kind)) latestFinding.set(entry.kind, entry);
  }
  const findings = [...latestFinding.values()]
    .filter((entry) => entry.seq < (recent[0]?.seq ?? Infinity))
    .sort((a, b) => a.seq - b.seq);

  const olderGates = older.filter((entry) => entry.kind === "gate");
  const keptGates = olderGates.slice(Math.max(0, olderGates.length - level.gates));
  const droppedGates = olderGates.length - keptGates.length;

  if (keptGates.length > 0 || droppedGates > 0) {
    lines.push("", "## gate decisions");
    if (droppedGates > 0) lines.push(`(${droppedGates} earlier gate decisions omitted)`);
    for (const entry of keptGates) lines.push(entryLine(entry, level.lineChars));
  }

  if (findings.length > 0) {
    lines.push("", "## open findings (latest per kind)");
    for (const entry of findings) lines.push(entryLine(entry, level.lineChars));
  }

  if (recent.length > 0) {
    lines.push("", `## recent (last ${recent.length})`);
    for (const entry of recent) lines.push(entryLine(entry, level.lineChars));
  }

  if (level.earlier !== "none" && older.length > 0) {
    lines.push("", "## earlier");
    lines.push(digestLine(older));
  }

  return lines.join("\n");
}

/**
 * The living summary (M30): a bounded, self-contained account of a ticket's
 * journal, regenerated from the journal itself.
 *
 * Deterministic on purpose. The same journal always produces the same string,
 * so the summary is testable, diffable, reproducible years later for an
 * auditor, and — crucially — it exists even when no model is reachable. The
 * optional model pass (`enrichLivingSummary`) only ever *adds* to it.
 */
export function buildLivingSummary(
  runId: string,
  entries: readonly JournalEntry[],
  options: SummaryOptions = {},
): LivingSummary {
  const recentCount = options.recentCount ?? DEFAULT_RECENT_COUNT;
  const lineChars = options.lineChars ?? DEFAULT_LINE_CHARS;
  if (!Number.isInteger(recentCount) || recentCount < 1) {
    throw new MemoryArgumentError("recentCount", "must be a positive integer");
  }
  if (!Number.isInteger(lineChars) || lineChars < 40) {
    throw new MemoryArgumentError("lineChars", "must be an integer of at least 40");
  }
  const maxChars = Math.min(options.maxChars ?? SUMMARY_MAX_CHARS, SUMMARY_MAX_CHARS);
  if (maxChars < MIN_MAX_CHARS) {
    throw new MemoryArgumentError("maxChars", `must be at least ${MIN_MAX_CHARS}`);
  }

  const sorted = normalise(runId, entries);
  const upToSeq = sorted[sorted.length - 1]?.seq ?? 0;

  let text = "";
  for (const level of ladder(recentCount, lineChars)) {
    text = render(runId, sorted, level);
    if (text.length <= maxChars) break;
  }
  // Last resort: a journal of pathological single entries can still overflow
  // the narrowest level. Truncating is preferable to failing — a clipped
  // summary is context, an exception is context loss.
  text = clip(text, maxChars);

  options.guard?.assertClean(text, "living-summary");
  return LivingSummary.parse({ runId, upToSeq, text });
}

/** Optional model pass over a finished summary. Never the source of truth. */
export type SummaryEnricher = (input: {
  readonly summary: LivingSummary;
  readonly entries: readonly JournalEntry[];
}) => Promise<string>;

export interface EnrichOptions extends SummaryOptions {
  /** Off by default: no enricher, no model call, no non-determinism. */
  readonly enrich?: SummaryEnricher;
  /** Masks the model's answer before it joins the record (M82). Required with `enrich`. */
  readonly masker?: JournalMasker;
  /** Told when a model pass was dropped, so the caller can journal it. */
  readonly onEnrichFailed?: (error: unknown) => void;
}

const NOTES_HEADING = "\n\n## notes (model)\n";

/**
 * Deterministic summary, optionally with a model-written note appended.
 *
 * The note is *appended*, never substituted: every guaranteed section is
 * already in the text before the model is asked anything, so a hallucinating,
 * failing or unreachable model can subtract nothing. A failed pass returns the
 * deterministic summary unchanged.
 */
export async function enrichLivingSummary(
  runId: string,
  entries: readonly JournalEntry[],
  options: EnrichOptions = {},
): Promise<LivingSummary> {
  const base = buildLivingSummary(runId, entries, options);
  const { enrich, masker } = options;
  if (enrich === undefined) return base;
  if (masker === undefined) {
    throw new MemoryArgumentError("enrichLivingSummary", "an enricher requires a masker (M82)");
  }

  const maxChars = Math.min(options.maxChars ?? SUMMARY_MAX_CHARS, SUMMARY_MAX_CHARS);
  const room = maxChars - base.text.length - NOTES_HEADING.length;
  if (room <= 0) return base;

  let note: string;
  try {
    note = masker.text(await enrich({ summary: base, entries }));
  } catch (error) {
    options.onEnrichFailed?.(error);
    return base;
  }
  const trimmed = clip(note.replace(/\s+$/, ""), room);
  if (trimmed.length === 0) return base;
  return LivingSummary.parse({
    runId: base.runId,
    upToSeq: base.upToSeq,
    text: `${base.text}${NOTES_HEADING}${trimmed}`,
  });
}
