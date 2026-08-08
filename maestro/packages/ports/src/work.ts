import type { CommandEnvelope, TicketKey, TicketSnapshot } from "@maestro/contracts";

/**
 * Work-item system port (Jira DC driver first — M46/M102).
 * Drivers must verify webhook signatures with the RAW body, fail-closed.
 */
export interface WorkPort {
  getTicket(key: TicketKey): Promise<TicketSnapshot>;
  /** body: ADF document (Jira DC) or plain text fallback. */
  addComment(key: TicketKey, body: unknown): Promise<{ commentId: string }>;
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
   * Optional: workflow transition. The DC driver does NOT implement this
   * (M102 — no workflow permissions; progress is shown via labels/comments)
   * and throws CapabilityNotSupportedError. Kept for future Cloud driver.
   */
  transition(key: TicketKey, transitionId: string): Promise<void>;
}
