import type { CiResultSignal } from "@maestro/contracts";

/**
 * CI port is PASSIVE (M12): CI runs under ADO branch policy; Maestro only
 * parses Service Hook events into workflow signals.
 */
export interface CiPort {
  /** Returns null for events that are not build results. */
  parseBuildEvent(rawBody: unknown): Promise<CiResultSignal | null>;
}
