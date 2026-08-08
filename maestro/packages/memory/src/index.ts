/**
 * @maestro/memory — the layer that makes an agent's context survive anything:
 * a restart, a rejection loop, a 60-day silence, a deleted workspace (M30/M65).
 *
 * Three artefacts, in dependency order:
 *  1. the **ticket journal** — append-only, masked, gap-free (`appendJournal`);
 *  2. the **living summary** — deterministic, ≤8000 chars, derived from 1;
 *  3. the **bootstrap package** — what a reopened session is handed, built
 *     from 2 plus the last diff, the open rejections and the protected paths.
 *
 * Nothing here deletes or rewrites a journal entry, and nothing here reaches
 * for a clock, a disk or a bucket on its own: the store, the storage port, the
 * clock and the randomness are all injected.
 */

// 1 — journal (M30, append-only)
export { appendJournal, DEFAULT_MAX_APPEND_ATTEMPTS } from "./journal.js";
export type { JournalDeps } from "./journal.js";
export { journalStoreFromDb } from "./store-db.js";
export type { JournalDelegate } from "./store-db.js";
export { systemClock } from "./types.js";
export type { Clock, JournalDraft, JournalStore } from "./types.js";

// 2 — living summary (M30, deterministic; the model pass is optional)
export {
  buildLivingSummary,
  enrichLivingSummary,
  DEFAULT_LINE_CHARS,
  DEFAULT_RECENT_COUNT,
  FINDING_KINDS,
  SUMMARY_MAX_CHARS,
} from "./summary.js";
export type { EnrichOptions, SummaryEnricher, SummaryOptions } from "./summary.js";
export { clip, digestLine, entryLine, kindCounts, oneLine } from "./summary-format.js";

// 3 — bootstrap package (M30/M65)
export { buildBootstrapPackage, openRejections, BOOTSTRAP_MAX_CHARS } from "./bootstrap.js";
export type {
  BootstrapDeps,
  BootstrapInput,
  BootstrapPackage,
  DiffDigest,
  DiffSummaryInput,
  OpenRejection,
} from "./bootstrap.js";

// protected paths (M52) — the warning a resumed session is given
export {
  compileProtectedPaths,
  normalisePath,
  protectedPathHits,
  DEFAULT_PROTECTED_PATHS,
} from "./protected-paths.js";
export type { CompiledProtectedPaths, ProtectedPathHit } from "./protected-paths.js";

// masking boundary (M82) — the only way text enters the record
export { createJournalMasker } from "./masking.js";
export type {
  Journaled,
  JournalIdentity,
  JournalMasker,
  JournalMaskingOptions,
  JournalText,
  MaskedJournalEntry,
} from "./masking.js";

// session files (M31) — encrypted, storage-port backed
export {
  listSessionKeys,
  loadSessionFile,
  saveSessionFile,
  sessionArchiveKey,
  sessionFileName,
  tryLoadSessionFile,
  SESSION_FILE_PREFIX,
  SESSION_FILE_SUFFIX,
} from "./session.js";
export type { SavedSession, SessionArchiveDeps, SessionRef } from "./session.js";
export {
  nodeRandom,
  openSessionBytes,
  sealSessionBytes,
  SEALED_OVERHEAD_BYTES,
  SESSION_KEY_BYTES,
} from "./crypto.js";
export type { RandomSource } from "./crypto.js";

// workspace archiving (M65)
export {
  decideWorkspaceArchive,
  idleDaysBetween,
  latestActivityAt,
  WORKSPACE_MAX_IDLE_DAYS,
} from "./archive.js";
export type { ArchiveDecision, ArchiveDecisionInput } from "./archive.js";

export {
  MemoryArgumentError,
  SeqAllocationError,
  SeqTakenError,
  SessionCryptoError,
} from "./errors.js";
