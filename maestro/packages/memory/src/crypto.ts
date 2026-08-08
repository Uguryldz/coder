import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import { SessionCryptoError } from "./errors.js";

/**
 * Agent SDK session files at rest (M31).
 *
 * The workspace itself lives on an encrypted volume, but the archived copy of
 * a session (M65) travels through StoragePort into a bucket the platform does
 * not own, so it is sealed here as well: AES-256-GCM, one random IV per seal,
 * header authenticated. GCM is authenticated encryption, so a truncated or
 * edited blob fails to open instead of decrypting to plausible garbage that a
 * resumed agent would treat as its own memory.
 *
 * The key is always injected — this module neither derives, stores nor
 * generates long-lived key material (M80: keys come from SecretPort).
 */
export const SESSION_KEY_BYTES = 32;

const MAGIC = Buffer.from("MSES", "ascii");
const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + 1;
/** Magic + version + IV + tag. */
export const SEALED_OVERHEAD_BYTES = HEADER_BYTES + IV_BYTES + TAG_BYTES;

/** Injected randomness, so a test can seal deterministically. */
export interface RandomSource {
  bytes(count: number): Uint8Array;
}

export const nodeRandom: RandomSource = {
  bytes: (count: number) => new Uint8Array(randomBytes(count)),
};

function assertKey(key: Uint8Array): Buffer {
  if (key.length !== SESSION_KEY_BYTES) {
    throw new SessionCryptoError(`key must be ${SESSION_KEY_BYTES} bytes, got ${key.length}`);
  }
  return Buffer.from(key);
}

function header(): Buffer {
  return Buffer.concat([MAGIC, Buffer.from([VERSION])]);
}

/** Seal a session file. Layout: `MSES` | version | iv(12) | tag(16) | ciphertext. */
export function sealSessionBytes(
  key: Uint8Array,
  plaintext: Uint8Array,
  random: RandomSource = nodeRandom,
): Uint8Array {
  const secret = assertKey(key);
  const iv = Buffer.from(random.bytes(IV_BYTES));
  if (iv.length !== IV_BYTES) {
    throw new SessionCryptoError(`iv must be ${IV_BYTES} bytes, got ${iv.length}`);
  }
  const head = header();
  const cipher = createCipheriv("aes-256-gcm", secret, iv);
  cipher.setAAD(head);
  const body = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
  return new Uint8Array(Buffer.concat([head, iv, cipher.getAuthTag(), body]));
}

/** Open a sealed session file. Any tampering is an error, never a fallback. */
export function openSessionBytes(key: Uint8Array, sealed: Uint8Array): Uint8Array {
  const secret = assertKey(key);
  if (sealed.length < SEALED_OVERHEAD_BYTES) throw new SessionCryptoError("blob is truncated");
  const buffer = Buffer.from(sealed);
  const head = buffer.subarray(0, HEADER_BYTES);
  if (!timingSafeEqual(head.subarray(0, MAGIC.length), MAGIC)) {
    throw new SessionCryptoError("not a maestro session blob");
  }
  const version = head[MAGIC.length];
  if (version !== VERSION) throw new SessionCryptoError(`unsupported format version ${version}`);
  const iv = buffer.subarray(HEADER_BYTES, HEADER_BYTES + IV_BYTES);
  const tag = buffer.subarray(HEADER_BYTES + IV_BYTES, SEALED_OVERHEAD_BYTES);
  const body = buffer.subarray(SEALED_OVERHEAD_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", secret, iv);
  decipher.setAAD(head);
  decipher.setAuthTag(tag);
  try {
    return new Uint8Array(Buffer.concat([decipher.update(body), decipher.final()]));
  } catch {
    // The cause is deliberately not echoed: it is the same for a wrong key and
    // for a tampered blob, and neither may leak anything about the key.
    throw new SessionCryptoError("authentication failed (wrong key or altered blob)");
  }
}
