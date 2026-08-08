import { ObjectNotFoundError } from "@maestro/storage";
import { describe, expect, it } from "vitest";
import { SESSION_KEY_BYTES, type RandomSource } from "../src/crypto.js";
import { SessionCryptoError } from "../src/errors.js";
import {
  listSessionKeys,
  loadSessionFile,
  saveSessionFile,
  sessionArchiveKey,
  sessionFileName,
  tryLoadSessionFile,
  type SessionArchiveDeps,
} from "../src/session.js";
import { fakeStorage } from "./fakes/storage.js";
import { RUN_ID, TICKET_KEY } from "./fakes/support.js";

const KEY = new Uint8Array(SESSION_KEY_BYTES).fill(5);
const AT = "2026-08-08T10:00:00+03:00";
const SESSION = new TextEncoder().encode('{"sessionId":"s-1","turns":42}');
const random: RandomSource = { bytes: (count: number) => new Uint8Array(count).fill(9) };

function deps(): SessionArchiveDeps & { storage: ReturnType<typeof fakeStorage> } {
  return { storage: fakeStorage(), key: KEY, random };
}

describe("session archive keys", () => {
  it("uses the storage package's M65 archive layout", () => {
    expect(sessionArchiveKey({ ticketKey: TICKET_KEY, runId: RUN_ID, at: AT })).toBe(
      `archive/2026/${TICKET_KEY}/${sessionFileName(RUN_ID)}`,
    );
  });

  it("rejects a key that could not be parsed back", () => {
    expect(() => sessionArchiveKey({ ticketKey: "not a key", runId: RUN_ID, at: AT })).toThrow();
  });
});

describe("saveSessionFile / loadSessionFile", () => {
  it("stores ciphertext and reads the session back", async () => {
    const d = deps();
    const saved = await saveSessionFile(d, { ticketKey: TICKET_KEY, runId: RUN_ID, at: AT }, SESSION);

    const stored = d.storage.objects.get(saved.key);
    expect(stored).toBeDefined();
    expect(Buffer.from(stored as Uint8Array).toString("utf8")).not.toContain("sessionId");
    expect(saved.bytes).toBe((stored as Uint8Array).length);
    expect(await loadSessionFile(d, saved.key)).toEqual(SESSION);
  });

  it("cannot be read with another instance's key", async () => {
    const d = deps();
    const saved = await saveSessionFile(d, { ticketKey: TICKET_KEY, runId: RUN_ID, at: AT }, SESSION);
    const wrong = { ...d, key: new Uint8Array(SESSION_KEY_BYTES).fill(6) };
    await expect(loadSessionFile(wrong, saved.key)).rejects.toBeInstanceOf(SessionCryptoError);
  });

  it("reports a missing session as absence, not as failure (M65)", async () => {
    const d = deps();
    const key = sessionArchiveKey({ ticketKey: TICKET_KEY, runId: RUN_ID, at: AT });
    expect(await tryLoadSessionFile(d, key)).toBeNull();
    await expect(loadSessionFile(d, key)).rejects.toBeInstanceOf(ObjectNotFoundError);
  });

  it("never treats a damaged session as a fresh start", async () => {
    const d = deps();
    const saved = await saveSessionFile(d, { ticketKey: TICKET_KEY, runId: RUN_ID, at: AT }, SESSION);
    const blob = d.storage.objects.get(saved.key) as Uint8Array;
    blob[blob.length - 1] = (blob[blob.length - 1] as number) ^ 0xff;
    await expect(tryLoadSessionFile(d, saved.key)).rejects.toBeInstanceOf(SessionCryptoError);
  });

  it("survives a workspace that is gone: the archive is the only copy needed", async () => {
    const d = deps();
    const saved = await saveSessionFile(d, { ticketKey: TICKET_KEY, runId: RUN_ID, at: AT }, SESSION);
    // The runner disk is wiped; nothing but the bucket remains.
    const restored = await tryLoadSessionFile({ ...d, storage: d.storage }, saved.key);
    expect(restored).toEqual(SESSION);
  });
});

describe("listSessionKeys", () => {
  it("finds this package's session files and ignores everything else", async () => {
    const d = deps();
    await saveSessionFile(d, { ticketKey: TICKET_KEY, runId: RUN_ID, at: AT }, SESSION);
    await saveSessionFile(
      d,
      { ticketKey: TICKET_KEY, runId: "run-UGURPAY-1234-b", at: AT },
      SESSION,
    );
    await d.storage.put(`archive/2026/${TICKET_KEY}/notes.txt`, new Uint8Array([1]));
    await d.storage.put(`archive/2026/OTHER-1/${sessionFileName(RUN_ID)}`, new Uint8Array([1]));

    const keys = await listSessionKeys(d.storage, TICKET_KEY, 2026);
    expect(keys).toEqual([
      `archive/2026/${TICKET_KEY}/${sessionFileName("run-UGURPAY-1234-b")}`,
      `archive/2026/${TICKET_KEY}/${sessionFileName(RUN_ID)}`,
    ]);
  });

  it("is empty for a year with no archive", async () => {
    const d = deps();
    expect(await listSessionKeys(d.storage, TICKET_KEY, 2025)).toEqual([]);
  });
});
