import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerRuntime, ToolCallResult } from "./runtime.js";
import type { CallerIdentity } from "./scopes.js";

/**
 * Binds a runtime to an MCP SDK server object.
 *
 * One binding, both transports. The SDK's `McpServer` is transport-agnostic:
 * the same object returned here serves an agent sandbox over stdio (M37) and
 * the BFF's `/mcp` endpoint over streamable HTTP (M101) — see
 * `src/transports.ts`. That is the whole reason the rules live in
 * `McpServerRuntime` and not in this file: a second transport must not be able
 * to arrive with a second, weaker gate.
 *
 * The binding is PER CALLER. A personal token identifies one person, the tool
 * list is filtered to what that person may call, and the audit actor is fixed
 * at bind time — so a connection cannot be re-pointed at another identity
 * halfway through a session.
 *
 * One honest limitation: the SDK validates arguments against the published
 * input schema BEFORE the callback runs, so a client that sends malformed
 * arguments is rejected by the SDK and that rejection produces no audit
 * record. Nothing was executed and no state was touched — it is the MCP
 * equivalent of a malformed HTTP request. Every call that reaches the
 * platform, including every refusal the platform itself makes, is recorded.
 */
export function bindMcpServer(runtime: McpServerRuntime, caller: CallerIdentity): McpServer {
  const server = new McpServer({
    name: runtime.name,
    version: runtime.definition.version,
    description: runtime.definition.description,
  });

  for (const tool of runtime.listTools(caller)) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.input,
        // Scope travels with the tool so a client (and a human reading a
        // session log) can see which permission each call spends.
        _meta: { "maestro/scope": tool.scope },
      },
      async (args: unknown): Promise<CallToolResult> =>
        toCallToolResult(await runtime.call(tool.name, args, caller)),
    );
  }

  return server;
}

/**
 * A refusal is returned as `isError: true` with the reason in the text, not as
 * a transport-level failure: the model must be able to read "that path is
 * protected, a human has to make this change" and pick another route, which a
 * dropped connection would never let it do.
 */
export function toCallToolResult(result: ToolCallResult): CallToolResult {
  if (result.status === "ok") {
    return { content: [{ type: "text", text: stringify(result.value) }] };
  }
  return {
    isError: true,
    content: [{ type: "text", text: `${result.reason}: ${result.message}` }],
    _meta: { "maestro/denialReason": result.reason },
  };
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value ?? null, null, 2);
}
