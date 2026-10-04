import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { JiraCommandsSection } from "../src/screens/help/JiraCommands.tsx";
import { McpServerSection } from "../src/screens/help/McpServer.tsx";
import { renderScreen, stubFetch } from "./harness.tsx";

/**
 * The two reference tabs of Help (P7) — formerly the /commands and /mcp
 * screens. What must survive the move is the security wording each carries:
 * a comment with extra text is not an approval, and the MCP server has no
 * gate-decision tool by design.
 */

describe("help — Jira commands", () => {
  it("states that a comment with extra text is not an approval", async () => {
    const { fetchImpl } = stubFetch([
      {
        path: "/commands",
        body: {
          commands: [
            {
              name: "/approve",
              roles: ["tech-lead"],
              takesArgument: false,
              whenKey: "commands.when.gate_open",
              effectKey: "commands.effect.approve",
            },
          ],
        },
      },
    ]);
    renderScreen(<JiraCommandsSection />, { fetchImpl });

    expect(await screen.findByText("/approve")).toBeInTheDocument();
    expect(screen.getByText("Açık onay kapısı varken")).toBeInTheDocument();
    expect(screen.getByText(/onay SAYILMAZ/)).toBeInTheDocument();
    expect(screen.getByText(/sonradan onay yazılamaz/)).toBeInTheDocument();
  });
});

describe("help — Maestro MCP", () => {
  it("shows the forbidden tools as absent by design", async () => {
    const { fetchImpl } = stubFetch([
      {
        path: "/mcp/manifest",
        body: {
          endpoint: "maestro-mcp · /mcp",
          auditActor: "ai-via:<user>",
          tools: [
            {
              name: "propose_killswitch",
              scope: "admin-proposal",
              descriptionKey: "mcp.tool.propose_killswitch",
            },
          ],
          forbiddenTools: ["approve_gate", "reject_gate", "merge_pr"],
        },
      },
    ]);
    renderScreen(<McpServerSection />, { fetchImpl });

    expect(await screen.findByText("approve_gate")).toBeInTheDocument();
    expect(screen.getByText("merge_pr")).toBeInTheDocument();
    expect(screen.getByText(/karar veremez/)).toBeInTheDocument();
    // The proposal scope must be labelled as such, not as a plain admin power.
    expect(screen.getByText("admin-öneri")).toBeInTheDocument();
    // The connection facts come from the manifest, not from a constant.
    expect(screen.getByText("maestro-mcp · /mcp")).toBeInTheDocument();
    expect(screen.getByText("ai-via:<user>")).toBeInTheDocument();
  });
});
