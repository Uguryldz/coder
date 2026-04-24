import { JiraCommand } from "@orkestra/contracts";

export const JIRA_COMMAND_NAMES = [
  "approve",
  "reject",
  "cancel",
  "ai-analyze",
  "ai-write-test",
  "ai-explain",
  "ai-takeover",
  "ai-handoff",
  "mode-change",
  "retry",
  "status",
] as const satisfies ReadonlyArray<JiraCommand>;

export interface ParsedJiraCommand {
  command: JiraCommand;
  args: string;
  raw: string;
}

const COMMAND_SET = new Set<string>(JIRA_COMMAND_NAMES);

/**
 * Extract a slash command from free-form comment text.
 *
 * Accepts:
 *   - "/approve"                         -> { command: "approve", args: "" }
 *   - "  /Approve reason here ..."       -> { command: "approve", args: "reason here ..." }
 *   - "/ai-analyze please explain this"  -> { command: "ai-analyze", args: "please explain this" }
 *
 * Returns `null` if no recognized command is present. The first line of the
 * comment that begins with a slash is used; additional lines become args.
 */
export function parseJiraCommand(text: string | null | undefined): ParsedJiraCommand | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;

  // Split the first token (the command) off; the remainder is args.
  const match = /^\/([a-zA-Z][a-zA-Z0-9-]*)\b[ \t]*(.*)$/s.exec(trimmed);
  if (!match) return null;

  const rawCmd = match[1]!.toLowerCase();
  const args = match[2] ? match[2].trim() : "";

  if (!COMMAND_SET.has(rawCmd)) return null;

  return {
    command: rawCmd as JiraCommand,
    args,
    raw: trimmed,
  };
}
