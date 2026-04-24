import type { KnowledgePack } from "@orkestra/contracts";
import { describe, expect, it } from "vitest";
import { compileSystemPrompt } from "./prompt.js";

describe("compileSystemPrompt", () => {
  it("returns persona block + output directive when no knowledge", () => {
    const out = compileSystemPrompt("You are an analyst.", null);
    expect(out.systemBlocks.length).toBe(2);
    expect(out.systemBlocks[0]!.text).toContain("analyst");
    expect(out.systemBlocks[0]!.cache_control?.type).toBe("ephemeral");
    expect(out.systemBlocks[1]!.text).toContain("JSON");
  });

  it("adds cacheable knowledge section when pack has files", () => {
    const pack: KnowledgePack = {
      variantId: "v1",
      variantName: "mobile-analyst",
      role: "analyst",
      files: [
        {
          id: "r1",
          filename: "accessibility.md",
          category: "rules",
          content: "use VoiceOver",
          scope: "variant",
          version: 1,
        },
        {
          id: "c1",
          filename: "terminology.md",
          category: "conventions",
          content: "prefer Turkish",
          scope: "variant",
          version: 1,
        },
        {
          id: "d1",
          filename: "refunds.md",
          category: "domain",
          content: ">500 → manager",
          scope: "shared",
          version: 2,
        },
      ],
    };
    const out = compileSystemPrompt("You are an analyst.", pack);
    expect(out.systemBlocks.length).toBe(3);
    const packBlock = out.systemBlocks[1]!;
    expect(packBlock.cache_control?.type).toBe("ephemeral");
    expect(packBlock.text).toContain("accessibility.md");
    expect(packBlock.text).toContain("terminology.md");
    expect(packBlock.text).toContain("refunds.md");
    expect(packBlock.text).toContain("Zorunlu Kurallar");
  });
});
