import { AppId, ParsedCommand, WorkMode } from "@maestro/contracts";

/**
 * Jira comment command grammar (M46; mock screen "Jira komut seti" is the
 * reference UX). Only the FIRST line of a comment is inspected: the rest is
 * free prose the reporter may attach to the same comment.
 */

/** Catalog keys the caller renders — no user-facing literals here (M104). */
export const COMMAND_MESSAGE_KEYS = {
  unknown: "command.unknown",
  rejectNeedsReason: "command.reject_needs_reason",
  invalidAppId: "command.invalid_app_id",
  invalidMode: "command.invalid_mode",
} as const;

export const COMMAND_LIST = [
  "/approve",
  "/reject",
  "/status",
  "/ai-explain",
  "/ai-start",
  "/ai-assign",
  "/mode-change",
  "/ai-takeover",
] as const;

/**
 * Structured outcome so the BFF can answer a mistyped command instead of
 * silently ignoring it (M14: no silent defaults). `none` = the comment simply
 * is not a command; `invalid` = it looks like one but the argument is wrong.
 */
export type CommandParseResult =
  | { status: "ok"; command: ParsedCommand }
  | { status: "none" }
  | { status: "invalid"; command: string; messageKey: string; messageParams: Record<string, string> };

const NONE: CommandParseResult = { status: "none" };

function invalid(command: string, messageKey: string, messageParams: Record<string, string> = {}): CommandParseResult {
  return { status: "invalid", command, messageKey, messageParams };
}

/** Parse a whole comment body: only its first non-empty line can be a command. */
export function parseCommandBody(body: unknown): CommandParseResult {
  if (typeof body !== "string") return NONE;
  const firstLine = body.split(/\r?\n/).find((line) => line.trim().length > 0);
  return firstLine === undefined ? NONE : parseCommandLine(firstLine);
}

/** Parse a single line. Never throws — an unknown command is data, not a fault. */
export function parseCommandLine(line: string): CommandParseResult {
  const trimmed = line.trim();
  if (!trimmed.startsWith("/")) return NONE;

  const [rawName = "", ...rest] = trimmed.split(/\s+/);
  const name = rawName.slice(1).toLowerCase();
  const argument = rest.join(" ").trim();

  switch (name) {
    case "approve":
      return { status: "ok", command: { name: "approve" } };
    case "status":
      return { status: "ok", command: { name: "status" } };
    case "ai-explain":
      return { status: "ok", command: { name: "ai-explain" } };
    case "ai-start":
      return { status: "ok", command: { name: "ai-start" } };
    case "ai-takeover":
      return { status: "ok", command: { name: "ai-takeover" } };
    case "reject": {
      if (argument.length === 0) return invalid(name, COMMAND_MESSAGE_KEYS.rejectNeedsReason);
      return { status: "ok", command: { name: "reject", reason: argument } };
    }
    case "ai-assign": {
      const appId = AppId.safeParse(argument.toLowerCase());
      if (!appId.success) return invalid(name, COMMAND_MESSAGE_KEYS.invalidAppId, { value: argument });
      return { status: "ok", command: { name: "ai-assign", appId: appId.data } };
    }
    case "mode-change": {
      // The UI writes both `ai-assist` and `ai_assist`; the contract enum is
      // snake_case, so hyphens are normalised rather than rejected.
      const mode = WorkMode.safeParse(argument.toLowerCase().replace(/-/g, "_"));
      if (!mode.success) {
        return invalid(name, COMMAND_MESSAGE_KEYS.invalidMode, {
          value: argument,
          modes: WorkMode.options.join(" · "),
        });
      }
      return { status: "ok", command: { name: "mode-change", mode: mode.data } };
    }
    default:
      return invalid(name, COMMAND_MESSAGE_KEYS.unknown, { commands: COMMAND_LIST.join(" ") });
  }
}
