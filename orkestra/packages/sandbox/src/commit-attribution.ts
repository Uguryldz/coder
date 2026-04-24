const AI_PREFIX = "[AI] ";
const CO_AUTHOR = "Co-Authored-By: Claude <noreply@anthropic.com>";

/**
 * Build a canonical git commit message honouring Orkestra's attribution
 * rules:
 *   - AI-authored commits must have subject prefixed `[AI] ` and include a
 *     `Co-Authored-By: Claude` trailer.
 *   - Human-lead commits (AI may assist) keep the author's subject as-is
 *     and only append the `Refs:` footer.
 * The `Refs:` trailer always includes the Jira ticket key so downstream
 * tooling can link commit -> ticket.
 */
export function formatCommitMessage(
  ticketKey: string,
  aiGenerated: boolean,
  originalMessage: string,
): string {
  const lines = originalMessage.replace(/\r\n/g, "\n").split("\n");
  const subjectRaw = (lines[0] ?? "").trim();
  const bodyLines = lines.slice(1);

  // Drop any existing trailing blank lines for deterministic output.
  while (bodyLines.length && bodyLines[bodyLines.length - 1]!.trim() === "") bodyLines.pop();

  let subject = subjectRaw;
  if (aiGenerated) {
    if (!subject.toUpperCase().startsWith("[AI]")) {
      subject = AI_PREFIX + subject;
    } else if (!subject.startsWith(AI_PREFIX)) {
      // Normalize casing/spacing.
      subject = AI_PREFIX + subject.replace(/^\[ai\]\s*/i, "");
    }
  }

  const trailers: string[] = [];
  // Avoid duplicate Refs trailers if caller already embedded one.
  if (!bodyLines.some((l) => /^Refs:\s/i.test(l.trim()))) {
    trailers.push(`Refs: ${ticketKey}`);
  }
  if (aiGenerated && !bodyLines.some((l) => /^Co-Authored-By:/i.test(l.trim()))) {
    trailers.push(CO_AUTHOR);
  }

  const parts: string[] = [subject];
  if (bodyLines.length) {
    parts.push("");
    parts.push(...bodyLines);
  }
  if (trailers.length) {
    parts.push("");
    parts.push(...trailers);
  }

  return parts.join("\n");
}
