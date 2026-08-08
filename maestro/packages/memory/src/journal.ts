import type { JournalEntry } from "@maestro/contracts";
import { MemoryArgumentError, SeqAllocationError, SeqTakenError } from "./errors.js";
import type { JournalMasker } from "./masking.js";
import type { Clock, JournalDraft, JournalStore } from "./types.js";

/** Retries are races, not failures; eight is far past any realistic fan-out. */
export const DEFAULT_MAX_APPEND_ATTEMPTS = 8;

export interface JournalDeps {
  readonly store: JournalStore;
  readonly masker: JournalMasker;
  readonly clock: Clock;
  /** Sequence-allocation attempts before giving up. Default 8. */
  readonly maxAttempts?: number;
}

/**
 * Per (store, run) write chains. Two appends to the same run inside one
 * process queue instead of racing, which keeps the common case at exactly one
 * round trip; the retry loop below is what makes appends from *other*
 * processes safe. The WeakMap is keyed by the store so a discarded store takes
 * its chains with it.
 */
const chains = new WeakMap<JournalStore, Map<string, Promise<void>>>();

function noop(): void {
  /* the chain must never reject: it only orders work */
}

function serialize<T>(store: JournalStore, runId: string, task: () => Promise<T>): Promise<T> {
  let byRun = chains.get(store);
  if (byRun === undefined) {
    byRun = new Map();
    chains.set(store, byRun);
  }
  const previous = byRun.get(runId) ?? Promise.resolve();
  const result = previous.then(task);
  const tail = result.then(noop, noop);
  byRun.set(runId, tail);
  const runs = byRun;
  void tail.then(() => {
    if (runs.get(runId) === tail) runs.delete(runId);
  });
  return result;
}

/**
 * Append one entry to the ticket journal (M30).
 *
 * The only write API this package has. There is no update and no delete —
 * neither here nor on `JournalStore` — because the journal is the raw material
 * of the evidence package (M34) and of the living summary, and a rewritable
 * record is worth nothing to an auditor.
 *
 * Sequence numbers are allocated as `max(seq) + 1` and the store rejects a
 * duplicate primary key, so concurrent writers cannot collide and cannot leave
 * a hole: a seq only exists once its row is committed, and the next writer
 * reads that committed head. A loser of the race simply re-reads and retries.
 *
 * The text is masked before it is sealed (M82) and the sealed entry is
 * re-checked for leaks, so raw PII can reach the journal neither through the
 * type system nor at runtime.
 */
export async function appendJournal(
  deps: JournalDeps,
  draft: JournalDraft,
): Promise<JournalEntry> {
  const attempts = deps.maxAttempts ?? DEFAULT_MAX_APPEND_ATTEMPTS;
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new MemoryArgumentError("maxAttempts", "must be a positive integer");
  }
  const at = draft.at ?? deps.clock.now();
  const text = deps.masker.prepare({ title: draft.title, detail: draft.detail ?? "" });
  const identity = {
    runId: draft.runId,
    at,
    actor: draft.actor,
    kind: draft.kind,
    ...(draft.cost === undefined ? {} : { cost: draft.cost }),
  };

  return serialize(deps.store, draft.runId, async () => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const head = await deps.store.maxSeq(draft.runId);
      const seq = head === null ? 0 : head + 1;
      const entry = deps.masker.seal({ ...identity, seq }, text);
      try {
        await deps.store.insert(entry);
        return entry;
      } catch (error) {
        // Only a lost race is retryable. Anything else (a dead connection, a
        // constraint we do not own) must surface: a swallowed write is the
        // context loss this package exists to prevent.
        if (!(error instanceof SeqTakenError)) throw error;
      }
    }
    throw new SeqAllocationError(draft.runId, attempts);
  });
}
