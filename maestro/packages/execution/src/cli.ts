import { ExecutionConfigError } from "./errors.js";

/**
 * Flag surface of the LOCAL `claude` CLI (M55 subscription driver): the seat is
 * an interactive login, not an API key, so the driver drives the binary instead
 * of an HTTP endpoint.
 *
 * Every flag below came out of `claude --help` (v2.1.226) — RAPOR §2. Two facts
 * from that output shape this file:
 *  · `--output-format stream-json` is rejected with `--print` unless `--verbose`
 *    is given too, so the two are emitted as a pair and never apart.
 *  · `--bare` is deliberately NOT used although it looks like the right
 *    isolation switch: it makes Anthropic auth "strictly ANTHROPIC_API_KEY or
 *    apiKeyHelper (OAuth and keychain are never read)" — exactly the credential
 *    a subscription seat does not have.
 */
export const PERMISSION_MODES = [
  "acceptEdits",
  "auto",
  "bypassPermissions",
  "manual",
  "dontAsk",
  "plan",
] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** Env var the CLI reads for a subscription seat token (`claude setup-token`). */
export const OAUTH_TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";
/** Per-seat config dir, so pooled seats (M55) never share session state. */
export const CONFIG_DIR_ENV = "CLAUDE_CONFIG_DIR";

/** Session ids the CLI accepts for `--session-id` are UUIDs. */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ClaudeCliOptions {
  readonly binPath: string;
  readonly model: string;
  /** MCP server names the turn may reach (K66: servers, not raw tools). */
  readonly mcpServers: readonly string[];
  /** Path to the MCP config file; when set, user-level servers are excluded. */
  readonly mcpConfigPath: string | null;
  /** Required on purpose: a default would be this package quietly deciding how
   * much a bank's agent may do unattended. */
  readonly permissionMode: PermissionMode;
  /** Fresh session: pin our own id. Mutually exclusive with `resumeSessionId`. */
  readonly sessionId?: string | null;
  /** Resume a previous turn (`--resume <sessionId>`), M30. */
  readonly resumeSessionId?: string | null;
}

function assertServerName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) {
    throw new ExecutionConfigError(`MCP server name "${name}" is not a plain identifier`);
  }
}

/**
 * Argv for one non-interactive turn. The prompt is NOT here: it goes over
 * stdin, so a task containing a leading dash or a newline can never be read as
 * a flag, and it never lands in the process table where `ps` would show it.
 */
export function buildClaudeArgs(opts: ClaudeCliOptions): string[] {
  if (opts.binPath.trim() === "") throw new ExecutionConfigError("claude binary path is empty");
  if (opts.model.trim() === "") throw new ExecutionConfigError("model is empty");
  if (!PERMISSION_MODES.includes(opts.permissionMode)) {
    throw new ExecutionConfigError(`unknown permission mode "${opts.permissionMode}"`);
  }
  const resume = opts.resumeSessionId ?? null;
  const fresh = opts.sessionId ?? null;
  if (resume !== null && fresh !== null) {
    throw new ExecutionConfigError("--session-id pins a NEW session; it cannot be combined with --resume");
  }
  for (const id of [resume, fresh]) {
    if (id !== null && !UUID_PATTERN.test(id)) {
      throw new ExecutionConfigError(`session id "${id}" is not a UUID; the CLI requires one`);
    }
  }

  // `--verbose` is a pair with stream-json, not decoration: the CLI refuses
  // `--print --output-format stream-json` without it.
  const args = ["--print", "--output-format", "stream-json", "--verbose", "--input-format", "text"];
  args.push("--model", opts.model, "--permission-mode", opts.permissionMode);

  if (opts.mcpConfigPath !== null && opts.mcpConfigPath.trim() !== "") {
    // --strict-mcp-config keeps the operator's personal ~/.claude servers out
    // of a bank workspace: only what the platform wrote is reachable.
    args.push("--mcp-config", opts.mcpConfigPath, "--strict-mcp-config");
  } else if (opts.mcpServers.length > 0) {
    throw new ExecutionConfigError("mcpServers were requested but no --mcp-config path was given");
  }

  if (opts.mcpServers.length > 0) {
    const allowed = opts.mcpServers.map((name) => {
      assertServerName(name);
      return `mcp__${name}`;
    });
    args.push("--allowedTools", ...allowed);
  }

  if (resume !== null) args.push("--resume", resume);
  else if (fresh !== null) args.push("--session-id", fresh);

  return args;
}

/**
 * Child environment, an explicit allow-list rather than `process.env`: an agent
 * turn must not inherit whatever secrets sit in the orchestrator's env (M80).
 */
export function buildClaudeEnv(input: {
  readonly basePath: string;
  readonly home: string;
  readonly oauthToken: string | null;
  readonly configDir?: string | null;
  readonly extra?: Readonly<Record<string, string>>;
}): Record<string, string> {
  const env: Record<string, string> = { PATH: input.basePath, HOME: input.home, ...input.extra };
  if (input.oauthToken !== null) env[OAUTH_TOKEN_ENV] = input.oauthToken;
  if (input.configDir != null && input.configDir !== "") env[CONFIG_DIR_ENV] = input.configDir;
  return env;
}
