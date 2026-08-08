import { describe, expect, it } from "vitest";
import {
  buildClaudeArgs,
  buildClaudeEnv,
  CONFIG_DIR_ENV,
  OAUTH_TOKEN_ENV,
  PERMISSION_MODES,
  type ClaudeCliOptions,
} from "../src/cli.js";
import { ExecutionConfigError } from "../src/errors.js";
import { OTHER_SESSION_ID, SESSION_ID } from "./helpers.js";

function opts(over: Partial<ClaudeCliOptions> = {}): ClaudeCliOptions {
  return {
    binPath: "/home/svc/.local/bin/claude",
    model: "claude-opus-4",
    mcpServers: [],
    mcpConfigPath: null,
    permissionMode: "acceptEdits",
    ...over,
  };
}

function pairAfter(args: string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
}

describe("buildClaudeArgs", () => {
  it("runs non-interactively with a machine-readable stream", () => {
    const args = buildClaudeArgs(opts());
    expect(args).toContain("--print");
    expect(pairAfter(args, "--output-format")).toBe("stream-json");
    expect(pairAfter(args, "--input-format")).toBe("text");
    expect(pairAfter(args, "--model")).toBe("claude-opus-4");
    expect(pairAfter(args, "--permission-mode")).toBe("acceptEdits");
  });

  it("always pairs stream-json with --verbose (the CLI refuses it otherwise)", () => {
    const args = buildClaudeArgs(opts());
    expect(args).toContain("--verbose");
    expect(args.indexOf("--verbose")).toBeGreaterThan(args.indexOf("--output-format"));
  });

  it("never uses --bare, which would cut a subscription seat off from its OAuth login", () => {
    expect(buildClaudeArgs(opts())).not.toContain("--bare");
  });

  it("keeps the prompt out of argv entirely", () => {
    const args = buildClaudeArgs(opts());
    expect(args.some((a) => a.includes("null check"))).toBe(false);
  });

  it("resumes by session id instead of starting over (M30)", () => {
    const args = buildClaudeArgs(opts({ resumeSessionId: SESSION_ID }));
    expect(pairAfter(args, "--resume")).toBe(SESSION_ID);
    expect(args).not.toContain("--session-id");
    expect(args).not.toContain("--fork-session");
  });

  it("pins a fresh session id when one is supplied", () => {
    const args = buildClaudeArgs(opts({ sessionId: SESSION_ID }));
    expect(pairAfter(args, "--session-id")).toBe(SESSION_ID);
    expect(args).not.toContain("--resume");
  });

  it("refuses to both pin and resume a session", () => {
    expect(() => buildClaudeArgs(opts({ sessionId: SESSION_ID, resumeSessionId: OTHER_SESSION_ID }))).toThrow(
      ExecutionConfigError,
    );
  });

  it("rejects a session id that is not a UUID", () => {
    expect(() => buildClaudeArgs(opts({ resumeSessionId: "session-7" }))).toThrow(/UUID/);
  });

  it("locks MCP access to the platform's own config", () => {
    const args = buildClaudeArgs(opts({ mcpServers: ["jira", "workspace"], mcpConfigPath: "/etc/maestro/mcp.json" }));
    expect(pairAfter(args, "--mcp-config")).toBe("/etc/maestro/mcp.json");
    expect(args).toContain("--strict-mcp-config");
    const at = args.indexOf("--allowedTools");
    expect(args.slice(at + 1, at + 3)).toEqual(["mcp__jira", "mcp__workspace"]);
  });

  it("refuses MCP servers with no config file rather than silently dropping them", () => {
    expect(() => buildClaudeArgs(opts({ mcpServers: ["jira"] }))).toThrow(/--mcp-config/);
  });

  it("rejects a server name that is not a plain identifier", () => {
    expect(() =>
      buildClaudeArgs(opts({ mcpServers: ["jira; rm -rf /"], mcpConfigPath: "/etc/mcp.json" })),
    ).toThrow(ExecutionConfigError);
  });

  it("rejects empty binary path, empty model and unknown permission mode", () => {
    expect(() => buildClaudeArgs(opts({ binPath: "  " }))).toThrow(ExecutionConfigError);
    expect(() => buildClaudeArgs(opts({ model: "" }))).toThrow(ExecutionConfigError);
    expect(() => buildClaudeArgs(opts({ permissionMode: "yolo" as never }))).toThrow(ExecutionConfigError);
  });

  it("accepts every permission mode the CLI documents", () => {
    for (const mode of PERMISSION_MODES) {
      expect(pairAfter(buildClaudeArgs(opts({ permissionMode: mode })), "--permission-mode")).toBe(mode);
    }
  });
});

describe("buildClaudeEnv", () => {
  it("builds an allow-list, not a copy of the orchestrator's environment", () => {
    const env = buildClaudeEnv({ basePath: "/usr/bin", home: "/home/seat1", oauthToken: "tok", configDir: "/var/seat1" });
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/seat1",
      [OAUTH_TOKEN_ENV]: "tok",
      [CONFIG_DIR_ENV]: "/var/seat1",
    });
  });

  it("omits the token when the seat is the machine's own login", () => {
    const env = buildClaudeEnv({ basePath: "/usr/bin", home: "/home/seat1", oauthToken: null });
    expect(env[OAUTH_TOKEN_ENV]).toBeUndefined();
    expect(env[CONFIG_DIR_ENV]).toBeUndefined();
  });
});
