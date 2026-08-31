import type { CommandEnvelope, TicketKey, TicketSnapshot } from "@maestro/contracts";

/**
 * Work-item system port (Jira DC driver first — M46/M102).
 * Drivers must verify webhook signatures with the RAW body, fail-closed.
 */
export interface WorkPort {
  /**
   * Verify a webhook's signature against the RAW body. MUST throw on a
   * missing/invalid signature — never return a boolean (fail-closed).
   * Part of the port because the BFF may not import driver modules (M44):
   * without it the only options are skipping verification or breaking DI.
   */
  verifyWebhook(rawBody: string | Uint8Array, headers: Record<string, string>): Promise<void>;
  getTicket(key: TicketKey): Promise<TicketSnapshot>;
  /** body: ADF document (Jira DC) or plain text fallback. */
  addComment(key: TicketKey, body: unknown): Promise<{ commentId: string }>;
  /** Edit the single live status comment instead of posting a new one (M75). */
  updateComment(key: TicketKey, commentId: string, body: unknown): Promise<void>;
  setLabels(key: TicketKey, labels: string[]): Promise<void>;
  assign(key: TicketKey, accountId: string | null): Promise<void>;
  /** Fan-out children (M100); links child to parent. */
  createLinkedIssue(
    parent: TicketKey,
    fields: { summary: string; description: string; labels?: string[] },
  ): Promise<{ key: TicketKey }>;
  /**
   * Parse a raw, signature-verified webhook payload into a command, or null
   * when the event carries none. Never throws on unknown commands.
   */
  parseCommand(rawBody: unknown): Promise<CommandEnvelope | null>;
  /** Group membership check backing gate authorization (M32/M51). */
  verifyMembership(userId: string, group: string): Promise<boolean>;
  /**
   * Workflow transition BY ID. Both Jira drivers implement it for real (Cloud
   * since M44, Data Center since M111 — the DC refusal was M102's "no workflow
   * permission is requested", and it stopped being true the day operators
   * configured a status map). A driver that genuinely cannot transition still
   * throws CapabilityNotSupportedError.
   *
   * A transition id belongs to ONE project's workflow and means nothing on
   * another, so a caller that knows only WHERE it wants the ticket reaches for
   * the concrete driver's `transitionToStatus` instead — the frozen port
   * cannot express its result-returning signature.
   */
  transition(key: TicketKey, transitionId: string): Promise<void>;
}
