import type { KnowledgePack } from "@orkestra/contracts";

/**
 * Compile a variant's system prompt + knowledge pack into the final prompt
 * that goes to Claude. Knowledge pack is placed in cacheable prefix.
 */
export interface CompiledPrompt {
  systemBlocks: Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }>;
  knowledgeHash: string;
}

export function compileSystemPrompt(
  systemPrompt: string,
  knowledge: KnowledgePack | null | undefined,
): CompiledPrompt {
  const blocks: CompiledPrompt["systemBlocks"] = [];

  // Static persona (cacheable)
  blocks.push({
    type: "text",
    text: systemPrompt,
    cache_control: { type: "ephemeral" },
  });

  if (knowledge && knowledge.files.length > 0) {
    const grouped = groupByCategory(knowledge.files);
    const sections: string[] = [];
    if (grouped.rules.length) {
      sections.push(
        `## Zorunlu Kurallar\n${grouped.rules.map((f) => `### ${f.filename}\n${f.content}`).join("\n\n")}`,
      );
    }
    if (grouped.conventions.length) {
      sections.push(
        `## Tercih Edilen Yaklaşımlar\n${grouped.conventions.map((f) => `### ${f.filename}\n${f.content}`).join("\n\n")}`,
      );
    }
    if (grouped.domain.length) {
      sections.push(
        `## Alan Bilgisi\n${grouped.domain.map((f) => `### ${f.filename}\n${f.content}`).join("\n\n")}`,
      );
    }
    if (grouped.examples.length) {
      sections.push(
        `## Örnekler\n${grouped.examples.map((f) => `### ${f.filename}\n${f.content}`).join("\n\n")}`,
      );
    }
    if (grouped.glossary.length) {
      sections.push(
        `## Terim Sözlüğü\n${grouped.glossary.map((f) => `### ${f.filename}\n${f.content}`).join("\n\n")}`,
      );
    }
    blocks.push({
      type: "text",
      text: sections.join("\n\n---\n\n"),
      cache_control: { type: "ephemeral" },
    });
  }

  // Structured output directive (not cached — schema name may vary by step)
  blocks.push({
    type: "text",
    text: `\n\n## Çıktı Formatı\nCevabın **yalnızca tek bir JSON nesnesi** olmalı, başka açıklama ekleme. JSON kod bloğu kullanma, doğrudan JSON ver.`,
  });

  return { systemBlocks: blocks, knowledgeHash: knowledge?.variantId ?? "none" };
}

function groupByCategory(files: KnowledgePack["files"]) {
  return {
    rules: files.filter((f) => f.category === "rules"),
    conventions: files.filter((f) => f.category === "conventions"),
    domain: files.filter((f) => f.category === "domain"),
    examples: files.filter((f) => f.category === "examples"),
    glossary: files.filter((f) => f.category === "glossary"),
  };
}
