import { AuditEvent } from "@maestro/contracts";
import { GENESIS, rehash } from "./hash.js";

/**
 * What went wrong, and where. `seq` is the sequence number of the record the
 * finding is about (or the expected one for a gap), because "the chain is
 * broken" is useless to an auditor — "record 412 was altered" is evidence.
 */
export type ChainIssueKind =
  /** The record does not match the AuditEvent contract at all. */
  | "schema_invalid"
  /** Stored hash ≠ hash recomputed from the record's own fields → the record was altered. */
  | "hash_mismatch"
  /** `prevHash` does not point at the previous record's hash → a record was removed or swapped. */
  | "prev_hash_mismatch"
  /** Sequence numbers skip → a record was deleted. */
  | "sequence_gap"
  /** Sequence numbers go backwards or repeat → records were reordered or duplicated. */
  | "out_of_order"
  /** The first record does not start the chain the way it was expected to. */
  | "bad_start";

export interface ChainIssue {
  readonly kind: ChainIssueKind;
  /** Sequence number the finding concerns; `null` when the record is too broken to read one. */
  readonly seq: number | null;
  /** Zero-based position in the array that was verified. */
  readonly index: number;
  readonly detail: string;
}

export interface ChainVerification {
  readonly ok: boolean;
  /** Number of records inspected — `ok` on an empty array proves nothing, and this says so. */
  readonly checked: number;
  /** Lowest `seq` with a finding; the record an investigation starts from. */
  readonly firstBadSeq: number | null;
  /** Hash of the last record, when the whole slice verified. */
  readonly headHash: string | null;
  readonly issues: readonly ChainIssue[];
}

export interface VerifyOptions {
  /** Expected `seq` of the first record. Defaults to 1 (the whole chain). */
  readonly expectFirstSeq?: number;
  /** Expected `prevHash` of the first record. Defaults to `"genesis"`. */
  readonly expectPrevHash?: string;
}

/**
 * Verify a chain, or a contiguous slice of one, from the records alone — no
 * database, no side state. Three attacks are detected by construction:
 *
 *  · altering a record  → its recomputed hash no longer matches (`hash_mismatch`);
 *  · deleting a record  → the next record's `prevHash` points at a hash that is
 *    no longer there and the sequence skips (`prev_hash_mismatch` + `sequence_gap`);
 *  · reordering records → `out_of_order` plus a broken link.
 *
 * All findings are collected (an auditor wants the full damage report), and
 * `firstBadSeq` names where the trail stops being trustworthy.
 */
export function verifyChain(events: readonly unknown[], options: VerifyOptions = {}): ChainVerification {
  const issues: ChainIssue[] = [];
  const expectFirstSeq = options.expectFirstSeq ?? 1;
  const expectPrevHash = options.expectPrevHash ?? GENESIS;

  let previous: AuditEvent | null = null;
  let index = 0;

  for (const candidate of events) {
    const parsed = AuditEvent.safeParse(candidate);
    if (!parsed.success) {
      const seq = readSeq(candidate);
      issues.push({
        kind: "schema_invalid",
        seq,
        index,
        detail: parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; "),
      });
      // Nothing further can be trusted about this record; the link check would
      // only produce noise, so move on but never mark the chain ok.
      previous = null;
      index += 1;
      continue;
    }

    const event = parsed.data;

    if (previous === null && index === 0) {
      if (event.seq !== expectFirstSeq) {
        issues.push({
          kind: "bad_start",
          seq: event.seq,
          index,
          detail: `chain starts at seq ${event.seq}, expected ${expectFirstSeq}`,
        });
      }
      if (event.prevHash !== expectPrevHash) {
        issues.push({
          kind: "bad_start",
          seq: event.seq,
          index,
          detail: `first record points at ${event.prevHash}, expected ${expectPrevHash}`,
        });
      }
    } else if (previous !== null) {
      if (event.seq <= previous.seq) {
        issues.push({
          kind: "out_of_order",
          seq: event.seq,
          index,
          detail: `seq ${event.seq} follows seq ${previous.seq}`,
        });
      } else if (event.seq !== previous.seq + 1) {
        issues.push({
          kind: "sequence_gap",
          seq: previous.seq + 1,
          index,
          detail: `seq jumps from ${previous.seq} to ${event.seq} — ${event.seq - previous.seq - 1} record(s) missing`,
        });
      }
      if (event.prevHash !== previous.hash) {
        issues.push({
          kind: "prev_hash_mismatch",
          seq: event.seq,
          index,
          detail: `prevHash ${event.prevHash} does not match the hash of seq ${previous.seq} (${previous.hash})`,
        });
      }
    }

    const expected = rehash(event);
    if (expected !== event.hash) {
      issues.push({
        kind: "hash_mismatch",
        seq: event.seq,
        index,
        detail: `stored hash ${event.hash} but the record hashes to ${expected} — the record was altered`,
      });
    }

    previous = event;
    index += 1;
  }

  const seqs = issues.map((issue) => issue.seq).filter((seq): seq is number => seq !== null);

  return {
    ok: issues.length === 0,
    checked: index,
    firstBadSeq: seqs.length > 0 ? Math.min(...seqs) : null,
    headHash: issues.length === 0 && previous !== null ? previous.hash : null,
    issues,
  };
}

function readSeq(candidate: unknown): number | null {
  if (typeof candidate !== "object" || candidate === null) return null;
  const seq = (candidate as { seq?: unknown }).seq;
  return typeof seq === "number" && Number.isFinite(seq) ? seq : null;
}
