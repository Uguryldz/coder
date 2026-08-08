/**
 * Injected runtime collaborators. Everything the drivers cannot compute
 * themselves — the Docker socket, the wall clock, timers, id generation, the
 * audit sink — arrives through these, so the default test suite is fully
 * offline and deterministic (insa-plani §2.3).
 */

/** Wall clock. Injected so durations and heartbeat deadlines are reproducible. */
export type Clock = () => Date;

export const systemClock: Clock = () => new Date();

/**
 * A cancellable delay. `runSession` races the container's exit against this,
 * so a fake timer makes the M23 timeout path testable without real waiting.
 */
export interface Delay {
  promise: Promise<void>;
  cancel(): void;
}

export type Timer = (milliseconds: number) => Delay;

export const systemTimer: Timer = (milliseconds) => {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<void>((resolve) => {
    handle = setTimeout(resolve, milliseconds);
    // Never keep the process alive for a timeout that nobody is waiting on.
    handle.unref?.();
  });
  return { promise, cancel: () => clearTimeout(handle) };
};

/** Opaque unique ids (lease ids, container name suffixes). */
export type IdSource = () => string;

/**
 * One request/response exchange over a byte pipe — in production a unix socket
 * connection to `/var/run/docker.sock`, in tests a pure function over recorded
 * bytes. The HTTP/1.1 framing lives in `http.ts`, ABOVE this interface, so a
 * test double never has to speak HTTP.
 *
 * The implementation must write `request` and resolve with every byte the peer
 * sent back until it closed the connection (the client sends `Connection:
 * close`), or reject on timeout.
 */
export interface DockerTransport {
  exchange(request: Uint8Array, options: { timeoutMs: number }): Promise<Uint8Array>;
}

/**
 * Audit hook (M33). The runner package does not depend on `@maestro/audit`:
 * it emits the facts, the composition root chains and seals them. Sandbox
 * create/destroy and audited workspace cleanup (M31) go through here.
 */
export interface AuditRecord {
  action: "SANDBOX_CREATE" | "SANDBOX_DESTROY" | "RETENTION_ARCHIVE";
  actor: string;
  subject: string;
  at: string;
  meta: Record<string, unknown>;
}

export type AuditSink = (record: AuditRecord) => void;

/** Actor name every runner-side audit record carries (contracts/audit.ts). */
export const RUNNER_ACTOR = "maestro-runner";
