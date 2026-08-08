import type { z } from "zod";
import type { GenerateObjectRequest, LlmCallLog } from "@maestro/contracts";

export interface AgentSessionOptions {
  workspacePath: string;
  task: string;
  resumeToken?: string;
  /** Tool access is MCP-first (K66); allowed server names, not raw tools. */
  mcpServers: string[];
}

export interface AgentSessionResult {
  resumeToken: string;
  finalText: string;
  log: LlmCallLog;
}

/**
 * LLM gateway port (M16/M17/M55). Driver selection (api vs subscription
 * pool) is policy inside the gateway, invisible to callers. When the
 * subscription pool is exhausted, calls queue instead of failing.
 */
export interface LlmPort {
  /** Thinking roles: single structured-output call validated against schema. */
  generateObject<T>(
    req: GenerateObjectRequest,
    schema: z.ZodType<T>,
  ): Promise<{ object: T; log: LlmCallLog }>;
  /** Doing roles: delegated agent session (Claude Agent SDK — M17). */
  agentSession(opts: AgentSessionOptions): Promise<AgentSessionResult>;
}
