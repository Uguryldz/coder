import { describe, expect, it } from "vitest";
import * as memory from "../src/index.js";
import { MemoryArgumentError, SeqAllocationError, SeqTakenError } from "../src/errors.js";
import { appendJournal, type JournalDeps } from "../src/journal.js";
import type { JournalStore } from "../src/types.js";
import { fakeJournalStore, JournalTable } from "./fakes/journal-table.js";
import { fixedClock, RUN_ID, SAMPLE_EMAIL, testMasker } from "./fakes/support.js";

const AT = "2026-08-08T10:00:00+03:00";

function deps(store: JournalStore, now = AT): JournalDeps {
  return { store, masker: testMasker(), clock: fixedClock(now) };
}

describe("appendJournal", () => {
  it("allocates sequence numbers from zero and stamps the injected clock", async () => {
    const table = new JournalTable();
    const store = fakeJournalStore(table);
    const first = await appendJournal(deps(store), {
      runId: RUN_ID,
      actor: "ai",
      kind: "intake",
      title: "ticket picked up",
    });
    const second = await appendJournal(deps(store), {
      runId: RUN_ID,
      actor: "human",
      kind: "gate",
      title: "PO approved",
      detail: "risk orta",
    });

    expect(first.seq).toBe(0);
    expect(second.seq).toBe(1);
    expect(first.at).toBe(AT);
    expect(table.of(RUN_ID).map((row) => row.seq)).toEqual([0, 1]);
    expect(table.of(RUN_ID)[1]?.detail).toBe("risk orta");
  });

  it("honours an explicit `at` so recorded events keep their own time", async () => {
    const store = fakeJournalStore(new JournalTable());
    const written = await appendJournal(deps(store), {
      runId: RUN_ID,
      actor: "system",
      kind: "ci",
      title: "build succeeded",
      at: "2026-07-01T08:30:00+03:00",
    });
    expect(written.at).toBe("2026-07-01T08:30:00+03:00");
  });

  it("keeps concurrent appends in one process gap-free", async () => {
    const table = new JournalTable();
    const store = fakeJournalStore(table, { yields: 3 });
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        appendJournal(deps(store), {
          runId: RUN_ID,
          actor: "ai",
          kind: "engineering",
          title: `step ${i}`,
        }),
      ),
    );

    const seqs = table.of(RUN_ID).map((row) => row.seq);
    expect(seqs).toEqual(Array.from({ length: 25 }, (_, i) => i));
    expect(new Set(seqs).size).toBe(25);
  });

  it("survives two processes writing the same run: no duplicate, no gap", async () => {
    const table = new JournalTable();
    // Two stores over one table = two runners; the in-process write chain of
    // one cannot see the other, so the primary key has to do the work.
    const a = fakeJournalStore(table, { yields: 2 });
    const b = fakeJournalStore(table, { yields: 2 });

    await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        appendJournal(deps(i % 2 === 0 ? a : b), {
          runId: RUN_ID,
          actor: "ai",
          kind: "engineering",
          title: `parallel ${i}`,
        }),
      ),
    );

    const seqs = table.of(RUN_ID).map((row) => row.seq);
    expect(seqs).toEqual(Array.from({ length: 40 }, (_, i) => i));
    // The race must actually have happened, otherwise this test proves nothing.
    expect(a.stats.conflicts + b.stats.conflicts).toBeGreaterThan(0);
  });

  it("keeps runs independent", async () => {
    const table = new JournalTable();
    const store = fakeJournalStore(table);
    await appendJournal(deps(store), { runId: RUN_ID, actor: "ai", kind: "intake", title: "a" });
    const other = await appendJournal(deps(store), {
      runId: "run-UGURPAY-9999",
      actor: "ai",
      kind: "intake",
      title: "b",
    });
    expect(other.seq).toBe(0);
  });

  it("gives up with SeqAllocationError when every attempt loses the race", async () => {
    const store: JournalStore = {
      maxSeq: async () => 4,
      insert: async (entry) => {
        throw new SeqTakenError(entry.runId, entry.seq);
      },
      list: async () => [],
    };
    await expect(
      appendJournal(
        { ...deps(store), maxAttempts: 3 },
        { runId: RUN_ID, actor: "ai", kind: "other", title: "doomed" },
      ),
    ).rejects.toBeInstanceOf(SeqAllocationError);
  });

  it("never retries a failure that is not a lost race", async () => {
    let attempts = 0;
    const store: JournalStore = {
      maxSeq: async () => null,
      insert: async () => {
        attempts += 1;
        throw new Error("connection reset");
      },
      list: async () => [],
    };
    await expect(
      appendJournal(deps(store), { runId: RUN_ID, actor: "ai", kind: "other", title: "x" }),
    ).rejects.toThrow("connection reset");
    expect(attempts).toBe(1);
  });

  it("rejects a nonsensical retry budget instead of looping forever", async () => {
    const store = fakeJournalStore(new JournalTable());
    await expect(
      appendJournal(
        { ...deps(store), maxAttempts: 0 },
        { runId: RUN_ID, actor: "ai", kind: "other", title: "x" },
      ),
    ).rejects.toBeInstanceOf(MemoryArgumentError);
  });

  it("validates the entry against the frozen contract", async () => {
    const store = fakeJournalStore(new JournalTable());
    await expect(
      appendJournal(deps(store), { runId: "short", actor: "ai", kind: "other", title: "x" }),
    ).rejects.toThrow();
    await expect(
      appendJournal(deps(store), { runId: RUN_ID, actor: "ai", kind: "other", title: "   " }),
    ).rejects.toThrow();
  });

  it("masks the text on its way in (M82)", async () => {
    const table = new JournalTable();
    const store = fakeJournalStore(table);
    await appendJournal(deps(store), {
      runId: RUN_ID,
      actor: "human",
      kind: "clarification",
      title: `customer wrote from ${SAMPLE_EMAIL}`,
      detail: `reply to ${SAMPLE_EMAIL}`,
    });
    const row = table.of(RUN_ID)[0];
    expect(row?.title).toContain("[EMAIL_1]");
    expect(row?.detail).toContain("[EMAIL_1]");
    expect(JSON.stringify(row)).not.toContain(SAMPLE_EMAIL);
  });
});

describe("the write surface", () => {
  it("exposes no way to change or remove a journal entry", () => {
    const forbidden = Object.keys(memory).filter((name) =>
      /^(update|delete|remove|purge|rewrite)/i.test(name),
    );
    expect(forbidden).toEqual([]);
  });

  it("has no mutating method on the store port", () => {
    const store = fakeJournalStore(new JournalTable());
    // @ts-expect-error — JournalStore is append-only: `update` does not exist.
    expect(store.update).toBeUndefined();
    // @ts-expect-error — JournalStore is append-only: `delete` does not exist.
    expect(store.delete).toBeUndefined();
  });
});
