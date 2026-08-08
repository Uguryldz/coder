import type { GateDecision, JournalEntry, LivingSummary, StepId } from "@maestro/contracts";
import type { JournalMasker } from "./masking.js";
import {
  compileProtectedPaths,
  DEFAULT_PROTECTED_PATHS,
  type ProtectedPathHit,
} from "./protected-paths.js";
import { buildLivingSummary, type SummaryOptions } from "./summary.js";
import { clip, oneLine } from "./summary-format.js";
import type { Clock } from "./types.js";

/** Bootstrap text ceiling. Generous — this is a prompt, not a database column. */
export const BOOTSTRAP_MAX_CHARS = 16000;
const MAX_LISTED_FILES = 30;
const MAX_LISTED_REJECTIONS = 10;

export interface DiffSummaryInput {
  readonly sha?: string;
  readonly filesChanged: readonly string[];
  readonly insertions?: number;
  readonly deletions?: number;
  /** Free text (a commit message, a reviewer note) — masked before it is used. */
  readonly note?: string;
}

export interface DiffDigest {
  readonly sha?: string;
  readonly fileCount: number;
  readonly files: readonly string[];
  readonly insertions?: number;
  readonly deletions?: number;
  readonly note?: string;
}

/** A gate whose latest decision is a rejection — work the agent still owes. */
export interface OpenRejection {
  readonly step: StepId;
  readonly at: string;
  readonly actorGroup: string;
  readonly reason: string;
}

export interface BootstrapInput {
  readonly runId: string;
  readonly ticketKey: string;
  /** Masked journal entries (whatever `appendJournal` wrote). */
  readonly entries: readonly JournalEntry[];
  readonly gateDecisions?: readonly GateDecision[];
  readonly lastDiff?: DiffSummaryInput;
  /** From `.maestro.yaml` (M71); defaults to the M52 built-ins. */
  readonly protectedPaths?: readonly string[];
  /** False after an M65 archive: the clone is gone, the context is not. */
  readonly workspacePresent: boolean;
  /** True when the Agent SDK session file could be restored (resume possible). */
  readonly sessionRestored?: boolean;
}

export interface BootstrapDeps {
  readonly masker: JournalMasker;
  readonly clock: Clock;
  readonly summary?: SummaryOptions;
  readonly maxChars?: number;
}

export interface BootstrapPackage {
  readonly runId: string;
  readonly ticketKey: string;
  readonly generatedAt: string;
  readonly upToSeq: number;
  readonly summary: LivingSummary;
  readonly openRejections: readonly OpenRejection[];
  readonly diff?: DiffDigest;
  readonly protectedPaths: readonly string[];
  readonly protectedPathHits: readonly ProtectedPathHit[];
  readonly workspacePresent: boolean;
  readonly sessionRestored: boolean;
  /** The masked, bounded text handed to the agent as its opening context. */
  readonly text: string;
}

/**
 * Gates whose most recent decision is a rejection.
 *
 * A later approval on the same step closes an earlier rejection — that is what
 * the reject/fix/re-approve loop (M54) means — so only the last decision per
 * step counts. Ordering is by `signatureSeq` (the signed, monotonic chain,
 * M33) with the timestamp as a tiebreak, never by array order.
 */
export function openRejections(
  decisions: readonly GateDecision[],
  maskReason: (text: string) => string,
): OpenRejection[] {
  const ordered = [...decisions].sort(
    (a, b) => a.signatureSeq - b.signatureSeq || a.at.localeCompare(b.at),
  );
  const latest = new Map<StepId, GateDecision>();
  for (const decision of ordered) latest.set(decision.step, decision);
  return [...latest.values()]
    .filter((decision) => decision.decision === "reject")
    .sort((a, b) => a.signatureSeq - b.signatureSeq)
    .map((decision) => ({
      step: decision.step,
      at: decision.at,
      actorGroup: decision.actorGroup,
      // The contract guarantees a reject carries a reason; be explicit anyway,
      // an empty rejection reason must not read as "nothing to fix".
      reason: maskReason(oneLine(decision.reason ?? "(no reason recorded)")),
    }));
}

function diffDigest(
  input: DiffSummaryInput,
  mask: (text: string) => string,
): { digest: DiffDigest; rawFiles: readonly string[] } {
  const files = input.filesChanged.map((file) => mask(file));
  return {
    rawFiles: input.filesChanged,
    digest: {
      ...(input.sha === undefined ? {} : { sha: input.sha }),
      fileCount: input.filesChanged.length,
      files,
      ...(input.insertions === undefined ? {} : { insertions: input.insertions }),
      ...(input.deletions === undefined ? {} : { deletions: input.deletions }),
      ...(input.note === undefined ? {} : { note: mask(oneLine(input.note)) }),
    },
  };
}

function diffSection(digest: DiffDigest): string[] {
  const counters = [
    digest.sha === undefined ? undefined : `sha ${digest.sha}`,
    `${digest.fileCount} file(s)`,
    digest.insertions === undefined ? undefined : `+${digest.insertions}`,
    digest.deletions === undefined ? undefined : `-${digest.deletions}`,
  ].filter((part): part is string => part !== undefined);
  const lines = ["", "## last diff", counters.join(" · ")];
  if (digest.note !== undefined) lines.push(`note: ${digest.note}`);
  for (const file of digest.files.slice(0, MAX_LISTED_FILES)) lines.push(`- ${file}`);
  if (digest.files.length > MAX_LISTED_FILES) {
    lines.push(`- (+${digest.files.length - MAX_LISTED_FILES} more files)`);
  }
  return lines;
}

/**
 * The context an agent is handed when a session is (re)opened — M30's third
 * leg and the whole point of M65.
 *
 * A workspace that has been idle for 60 days is deleted from disk; the journal
 * and the session file stay in the archive. This package is what makes that
 * deletion cheap: everything the agent needs to carry on — what happened, what
 * the last diff was, which gates rejected it and why, which paths it must not
 * touch — is rebuilt from the record, not from the missing clone. The only
 * thing lost is the ~5 minutes it takes to clone and build again.
 */
export function buildBootstrapPackage(
  input: BootstrapInput,
  deps: BootstrapDeps,
): BootstrapPackage {
  const mask = (text: string): string => deps.masker.text(text);
  const summary = buildLivingSummary(input.runId, input.entries, {
    ...deps.summary,
    guard: deps.masker,
  });
  const rejections = openRejections(input.gateDecisions ?? [], mask);
  const protectedPaths = input.protectedPaths ?? DEFAULT_PROTECTED_PATHS;
  const diff = input.lastDiff === undefined ? undefined : diffDigest(input.lastDiff, mask);

  // Matching runs on the real paths; only the reported copy is masked.
  const compiled = compileProtectedPaths(protectedPaths);
  const hits: ProtectedPathHit[] = [];
  for (const file of diff?.rawFiles ?? []) {
    const pattern = compiled.match(file);
    if (pattern !== undefined) hits.push({ file: mask(file), pattern });
  }

  const sessionRestored = input.sessionRestored ?? false;
  const lines: string[] = [
    `# bootstrap · ${input.ticketKey} · run ${input.runId}`,
    input.workspacePresent
      ? "workspace: present on the runner."
      : "workspace: ABSENT — the clone was removed after 60 days of inactivity (M65). " +
        "Recreate it from the repository; the context below is complete and nothing has been lost.",
    sessionRestored
      ? "session: restored from the archive — this is a continuation, not a fresh start."
      : "session: no agent session file available — start a new session from this context.",
    "",
    "## living summary",
    summary.text,
  ];

  if (rejections.length > 0) {
    lines.push("", "## open rejections (address these first)");
    for (const rejection of rejections.slice(-MAX_LISTED_REJECTIONS)) {
      lines.push(`step ${rejection.step} · ${rejection.at} · ${rejection.actorGroup}: ${rejection.reason}`);
    }
  }

  if (diff !== undefined) lines.push(...diffSection(diff.digest));

  lines.push("", "## protected paths (M52 — a diff here stops the flow)");
  for (const pattern of compiled.patterns) lines.push(`- ${pattern}`);
  if (hits.length > 0) {
    lines.push(
      `!! the last diff already touches protected paths: ${hits
        .map((hit) => `${hit.file} (${hit.pattern})`)
        .join(", ")}`,
    );
  }

  // Masked as a whole: anything a caller assembled by hand still goes through
  // the boundary before it becomes part of a ten-year record (M82).
  const text = clip(mask(lines.join("\n")), deps.maxChars ?? BOOTSTRAP_MAX_CHARS);

  return {
    runId: input.runId,
    ticketKey: input.ticketKey,
    generatedAt: deps.clock.now(),
    upToSeq: summary.upToSeq,
    summary,
    openRejections: rejections,
    ...(diff === undefined ? {} : { diff: diff.digest }),
    protectedPaths: compiled.patterns,
    protectedPathHits: hits,
    workspacePresent: input.workspacePresent,
    sessionRestored,
    text,
  };
}
