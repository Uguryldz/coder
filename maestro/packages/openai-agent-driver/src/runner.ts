import { randomUUID } from "node:crypto";
import { isSubscriptionDriver } from "@maestro/contracts";
import type { AgentRunInput, AgentRunOutput, AgentRunner, ChatMessage, LlmDriver } from "@maestro/llm-gateway";
import type { WorkspaceFs } from "@maestro/mcp-servers";
import { AgentStepBudgetError, AgentTransportError } from "./errors.js";
import { sessionKey } from "./node-fs.js";
import { type ToolMode, WorkspaceToolbox, toolSpecsFor } from "./tools.js";

export interface HttpAgentRunnerOptions {
  /** Builds the filesystem the tools operate on, rooted at the run's clone. */
  readonly fsFor: (workspacePath: string) => WorkspaceFs;
  /**
   * Which tool set a session gets. The engineering turn lists `workspace`
   * among its MCP servers and the analysis pass lists none — that is the
   * signal, the same one the CLI runner would use to decide what to mount.
   */
  readonly modeFor?: (input: AgentRunInput) => ToolMode;
  readonly protectedPaths?: readonly string[];
  /** Tool-call rounds before the session is declared stuck. */
  readonly maxSteps?: number;
  readonly maxTokens?: number;
  readonly temperature?: number;
  /** Conversations kept for resume, by vendor session id. */
  readonly maxSessions?: number;
  readonly newSessionId?: () => string;
  readonly systemPrompt?: (mode: ToolMode) => string;
}

const DEFAULT_MAX_STEPS = 80;
const DEFAULT_MAX_SESSIONS = 64;

/**
 * An `AgentRunner` over the gateway's own HTTP driver.
 *
 * The CLI runner (`ClaudeSubRunner`) needs a vendor binary on the host; a
 * bank whose model is an OpenAI-compatible endpoint has none, and until now
 * that meant no agent session at all — step 3ö and 6a refused, the analyst
 * stayed repo-blind and nothing was ever written to a clone. This runner
 * closes that: the model reads and edits the clone through four guarded
 * tools, in-process, over the same transport `generateObject` uses.
 *
 * The conversation lives in memory keyed by the id the gateway stores as
 * `vendorSessionId`; a resume after a worker restart starts a fresh
 * conversation, which is safe because the turn prompt already carries the
 * journal and the living summary (M30 bootstrap).
 */
export class HttpAgentRunner implements AgentRunner {
  private readonly sessions = new Map<string, ChatMessage[]>();

  constructor(private readonly options: HttpAgentRunnerOptions) {}

  async run(input: AgentRunInput): Promise<AgentRunOutput> {
    const transport = this.transportOf(input);
    const mode = this.options.modeFor?.(input) ?? defaultMode(input);
    const toolbox = new WorkspaceToolbox(this.options.fsFor(input.workspacePath), mode, this.options.protectedPaths ?? []);
    const tools = toolSpecsFor(mode);

    const vendorSessionId = input.vendorSessionId ?? (this.options.newSessionId?.() ?? randomUUID());
    const key = sessionKey(input.workspacePath, vendorSessionId);
    const history = this.sessions.get(key) ?? [{ role: "system", content: (this.options.systemPrompt ?? systemPromptFor)(mode) }];
    const messages: ChatMessage[] = [...history, { role: "user", content: input.task }];

    let tokensIn = 0;
    let tokensOut = 0;
    const maxSteps = this.options.maxSteps ?? DEFAULT_MAX_STEPS;
    for (let step = 0; step < maxSteps; step += 1) {
      const result = await transport.chat!({
        model: input.model,
        messages,
        tools,
        maxTokens: this.options.maxTokens ?? 8192,
        temperature: this.options.temperature ?? 0.2,
        ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
        ...(input.credentialRef === null ? {} : { credentialRef: input.credentialRef }),
        ...(input.skipTlsVerify === true ? { skipTlsVerify: true } : {}),
      });
      tokensIn += result.tokensIn;
      tokensOut += result.tokensOut;
      messages.push({ role: "assistant", content: result.text, toolCalls: result.toolCalls });
      if (result.toolCalls.length === 0) {
        this.remember(key, messages);
        return { finalText: result.text ?? "", tokensIn, tokensOut, vendorSessionId };
      }
      for (const call of result.toolCalls) {
        const executed = await toolbox.execute(call.name, call.arguments);
        messages.push({ role: "tool", toolCallId: call.id, content: executed.content });
      }
    }
    this.remember(key, messages);
    throw new AgentStepBudgetError(maxSteps);
  }

  private transportOf(input: AgentRunInput): LlmDriver & { chat: NonNullable<LlmDriver["chat"]> } {
    if (isSubscriptionDriver(input.driver)) {
      throw new AgentTransportError(
        `HttpAgentRunner was handed subscription driver "${input.driver}"; it only drives HTTP (API) drivers`,
      );
    }
    const transport = input.transport;
    if (transport === undefined) {
      throw new AgentTransportError("HttpAgentRunner needs the routed transport; the gateway did not pass one");
    }
    if (typeof transport.chat !== "function") {
      throw new AgentTransportError(
        `driver "${transport.id}" has no tool-calling chat; an agent session needs one (only openai-compat carries it today)`,
      );
    }
    return transport as LlmDriver & { chat: NonNullable<LlmDriver["chat"]> };
  }

  private remember(key: string, messages: ChatMessage[]): void {
    this.sessions.delete(key);
    this.sessions.set(key, messages);
    const max = this.options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    while (this.sessions.size > max) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
  }
}

/** `workspace` among the MCP servers = the engineering turn = writes allowed. */
export function defaultMode(input: AgentRunInput): ToolMode {
  return input.mcpServers.includes("workspace") ? "read-write" : "read";
}

export function systemPromptFor(mode: ToolMode): string {
  const shared = [
    "You are a senior software engineer working inside a bank's source repository checkout.",
    "You have tools to list directories, read files and search text. Paths are repository-relative; use \".\" for the root.",
    "Always inspect the repository before answering: start with list_dir on \".\" and read the files that matter (build manifests, entry points, the code the task names).",
    "Never guess file contents. Never claim to have read something you did not read.",
    "Secrets, credentials and CI/runner configuration are off-limits and the tools will refuse them; do not try to work around a refusal.",
    "When you are done, answer in the language of the task with a concise, structured report.",
  ];
  const write = [
    "You may also create or overwrite files with write_file; always pass the COMPLETE new content of the file.",
    "Make the smallest change that fulfils the task; keep the project's conventions; do not touch migrations, secrets or pipeline files.",
    "Finish with a short summary listing every file you changed and why, and how the change can be verified.",
  ];
  return (mode === "read-write" ? [...shared, ...write] : shared).join("\n");
}
