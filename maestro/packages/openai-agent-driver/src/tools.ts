import { z } from "zod";
import type { ChatToolSpec } from "@maestro/llm-gateway";
import {
  assertSearchGlob,
  guardWorkspacePath,
  redactSearchHits,
  ToolPolicyError,
  workspaceMatcher,
  type ProtectedPathMatcher,
  type WorkspaceFs,
} from "@maestro/mcp-servers";

/**
 * The four workspace tools, in the OpenAI function-calling shape, with the
 * SAME guards the MCP `workspace-mcp` server applies: deny-listed paths are
 * refused for writes, unreadable ones (secrets) for everything, globs and
 * paths cannot escape the clone. The runner does not go through the MCP
 * runtime because the model is talked to over HTTP in-process — but the
 * policy is the one place and this file only re-uses it.
 */
export const MAX_READ_BYTES = 512 * 1024;
export const MAX_WRITE_CHARS = 1_000_000;
export const MAX_SEARCH_HITS = 200;
/** What a single tool result may carry back into the conversation. */
export const MAX_TOOL_RESULT_CHARS = 60_000;

export type ToolMode = "read" | "read-write";

const ReadFileArgs = z.object({
  path: z.string().trim().min(1).max(1024),
  maxBytes: z.number().int().positive().max(MAX_READ_BYTES).default(MAX_READ_BYTES),
});
const ListDirArgs = z.object({ path: z.string().trim().min(1).max(1024).default(".") });
const SearchArgs = z.object({
  text: z.string().trim().min(2).max(400),
  glob: z.string().trim().min(1).max(200).optional(),
  limit: z.number().int().positive().max(MAX_SEARCH_HITS).default(50),
});
const WriteFileArgs = z.object({
  path: z.string().trim().min(1).max(1024),
  content: z.string().max(MAX_WRITE_CHARS),
});

const READ_TOOLS: readonly ChatToolSpec[] = [
  {
    name: "read_file",
    description: "Read a workspace file as UTF-8 text (truncated at maxBytes, default 512 KiB). Paths are repository-relative.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repository-relative path, e.g. src/index.ts" },
        maxBytes: { type: "integer", minimum: 1, maximum: MAX_READ_BYTES },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "list_dir",
    description: "List a workspace directory. Use \".\" for the repository root.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Repository-relative directory, \".\" for the root" } },
      additionalProperties: false,
    },
  },
  {
    name: "search_workspace",
    description: "Search file contents for a literal text, optionally narrowed by a glob such as \"**/*.ts\" or \"src/**\".",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "Literal text to find (not a regex)" },
        glob: { type: "string", description: "Optional file glob, repository-relative" },
        limit: { type: "integer", minimum: 1, maximum: MAX_SEARCH_HITS },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
];

const WRITE_TOOL: ChatToolSpec = {
  name: "write_file",
  description:
    "Create or overwrite a workspace file with the full new content. Refused for protected paths (migrations, secrets, CI and runner surfaces).",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Repository-relative path" },
      content: { type: "string", description: "The complete file content after the change" },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
};

export function toolSpecsFor(mode: ToolMode): readonly ChatToolSpec[] {
  return mode === "read" ? READ_TOOLS : [...READ_TOOLS, WRITE_TOOL];
}

export interface ToolExecution {
  /** JSON text handed back to the model as the tool's result. */
  readonly content: string;
  readonly ok: boolean;
}

export class WorkspaceToolbox {
  private readonly matcher: ProtectedPathMatcher;

  constructor(
    private readonly fs: WorkspaceFs,
    private readonly mode: ToolMode,
    protectedPaths: readonly string[] = [],
  ) {
    this.matcher = workspaceMatcher(protectedPaths);
  }

  /**
   * Executes one call. Policy refusals and filesystem errors come back as a
   * tool result carrying `error`, not as exceptions: the model has to see
   * why the call failed to choose another path, and a thrown error would
   * end the whole session over one bad argument.
   */
  async execute(name: string, rawArguments: string): Promise<ToolExecution> {
    try {
      const args = parseArguments(rawArguments);
      const value = await this.dispatch(name, args);
      return { ok: true, content: clamp(JSON.stringify(value)) };
    } catch (error) {
      const detail =
        error instanceof ToolPolicyError
          ? { error: error.message, rule: error.rule, tool: error.tool }
          : error instanceof z.ZodError
            ? { error: `invalid arguments: ${error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` }
            : { error: error instanceof Error ? error.message : String(error) };
      return { ok: false, content: JSON.stringify(detail) };
    }
  }

  private async dispatch(name: string, args: unknown): Promise<unknown> {
    switch (name) {
      case "read_file": {
        const a = ReadFileArgs.parse(args);
        return this.fs.readFile(guardWorkspacePath("read_file", this.matcher, a.path, "read"), a.maxBytes);
      }
      case "list_dir": {
        const a = ListDirArgs.parse(args);
        return this.fs.listDir(guardWorkspacePath("list_dir", this.matcher, a.path, "read"));
      }
      case "search_workspace": {
        const a = SearchArgs.parse(args);
        const glob = a.glob === undefined ? undefined : assertSearchGlob("search_workspace", a.glob);
        const hits = await this.fs.search({ text: a.text, glob, limit: a.limit });
        return redactSearchHits(hits);
      }
      case "write_file": {
        if (this.mode !== "read-write") {
          throw new ToolPolicyError("write_file", "read_only", "write_file: this session is read-only (an analysis step never edits source)");
        }
        const a = WriteFileArgs.parse(args);
        const path = guardWorkspacePath("write_file", this.matcher, a.path, "write");
        const { bytes } = await this.fs.writeFile(path, a.content);
        return { path, bytes };
      }
      default:
        throw new ToolPolicyError(name, "unknown_tool", `unknown tool "${name}"`);
    }
  }
}

function parseArguments(raw: string): unknown {
  if (raw.trim() === "") return {};
  return JSON.parse(raw) as unknown;
}

function clamp(text: string): string {
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_TOOL_RESULT_CHARS)}…(truncated, ${String(text.length - MAX_TOOL_RESULT_CHARS)} more chars)`;
}
