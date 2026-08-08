import { describe, expect, it } from "vitest";
import { SessionCryptoError } from "../src/errors.js";
import {
  nodeRandom,
  openSessionBytes,
  sealSessionBytes,
  SEALED_OVERHEAD_BYTES,
  SESSION_KEY_BYTES,
  type RandomSource,
} from "../src/crypto.js";

const KEY = new Uint8Array(SESSION_KEY_BYTES).fill(7);
const OTHER_KEY = new Uint8Array(SESSION_KEY_BYTES).fill(8);
const PLAIN = new TextEncoder().encode('{"messages":[{"role":"assistant"}]}');

const fixedRandom = (fill: number): RandomSource => ({
  bytes: (count: number) => new Uint8Array(count).fill(fill),
});

describe("session file sealing (M31)", () => {
  it("round-trips", () => {
    const sealed = sealSessionBytes(KEY, PLAIN, fixedRandom(1));
    expect(openSessionBytes(KEY, sealed)).toEqual(PLAIN);
  });

  it("does not leave the plaintext readable", () => {
    const sealed = sealSessionBytes(KEY, PLAIN, fixedRandom(1));
    expect(Buffer.from(sealed).toString("utf8")).not.toContain("assistant");
    expect(sealed.length).toBe(PLAIN.length + SEALED_OVERHEAD_BYTES);
  });

  it("produces a different blob for every IV", () => {
    const a = sealSessionBytes(KEY, PLAIN, nodeRandom);
    const b = sealSessionBytes(KEY, PLAIN, nodeRandom);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
    expect(openSessionBytes(KEY, a)).toEqual(openSessionBytes(KEY, b));
  });

  it("is reproducible when the randomness is injected", () => {
    const a = sealSessionBytes(KEY, PLAIN, fixedRandom(3));
    const b = sealSessionBytes(KEY, PLAIN, fixedRandom(3));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it("refuses the wrong key", () => {
    const sealed = sealSessionBytes(KEY, PLAIN, fixedRandom(1));
    expect(() => openSessionBytes(OTHER_KEY, sealed)).toThrow(SessionCryptoError);
  });

  it("refuses a tampered ciphertext instead of returning altered memory", () => {
    const sealed = sealSessionBytes(KEY, PLAIN, fixedRandom(1));
    const edited = new Uint8Array(sealed);
    const last = edited.length - 1;
    edited[last] = (edited[last] as number) ^ 0xff;
    expect(() => openSessionBytes(KEY, edited)).toThrow(/authentication failed/);
  });

  it("refuses a tampered header", () => {
    const sealed = sealSessionBytes(KEY, PLAIN, fixedRandom(1));
    const edited = new Uint8Array(sealed);
    edited[0] = 0x00;
    expect(() => openSessionBytes(KEY, edited)).toThrow(/not a maestro session blob/);
  });

  it("refuses an unknown format version", () => {
    const sealed = sealSessionBytes(KEY, PLAIN, fixedRandom(1));
    const edited = new Uint8Array(sealed);
    edited[4] = 9;
    expect(() => openSessionBytes(KEY, edited)).toThrow(/unsupported format version/);
  });

  it("refuses a truncated blob", () => {
    const sealed = sealSessionBytes(KEY, PLAIN, fixedRandom(1));
    expect(() => openSessionBytes(KEY, sealed.slice(0, 8))).toThrow(/truncated/);
  });

  it("refuses a key of the wrong size on both sides", () => {
    const short = new Uint8Array(16);
    expect(() => sealSessionBytes(short, PLAIN)).toThrow(SessionCryptoError);
    expect(() => openSessionBytes(short, sealSessionBytes(KEY, PLAIN))).toThrow(SessionCryptoError);
  });

  it("refuses a random source that returns the wrong length", () => {
    expect(() => sealSessionBytes(KEY, PLAIN, { bytes: () => new Uint8Array(4) })).toThrow(
      SessionCryptoError,
    );
  });

  it("handles an empty session file", () => {
    const sealed = sealSessionBytes(KEY, new Uint8Array(0), fixedRandom(2));
    expect(openSessionBytes(KEY, sealed)).toEqual(new Uint8Array(0));
  });
});
