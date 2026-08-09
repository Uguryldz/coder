import type { AnalysisContext, KnowledgePack } from "./context.js";
import type { Deficiency } from "./validate.js";
import type { AnalysisTemplate, TemplateSection } from "./template.js";
import { DEFAULT_PROMPT_TEXTS, type PromptTexts, text } from "./texts.js";

/**
 * Prompt assembly. Every sentence the model reads comes from the texts data
 * file or from the template, so a new section changes the prompt without a code
 * change (M108) and a variant changes the wording without one either (M38).
 */

export function block(title: string, body: string): string {
  return `## ${title}\n${body}`;
}

export function bullets(items: readonly string[], empty: string): string {
  return items.length === 0 ? empty : items.map((i) => `- ${i}`).join("\n");
}

/** Human-readable description of what a section's value must look like. */
export function formatHint(section: TemplateSection, texts: PromptTexts): string {
  const parts = [text(texts, `bicim.${section.format}`)];
  if (section.minItems !== undefined && section.minItems > 0) {
    parts.push(text(texts, "bicim.enAzMadde", { n: String(section.minItems) }));
  }
  if (section.columns) {
    parts.push(text(texts, "bicim.sutunlar", { liste: section.columns.join(" · ") }));
  }
  if (section.subFields) {
    parts.push(
      text(texts, "bicim.altAlanlar", {
        liste: section.subFields.map((f) => `${f.key} (${f.label})`).join(" · "),
      }),
    );
  }
  if (section.subLists) {
    parts.push(
      text(texts, "bicim.altAlanlar", {
        liste: section.subLists.map((l) => `${l.key} (${l.label})`).join(" · "),
      }),
    );
  }
  return parts.join(" · ");
}

/** The template rendered as instructions — the M108 core, data in, prompt out. */
export function renderTemplateSpec(template: AnalysisTemplate, texts: PromptTexts): string {
  const sections = template.sections.map((section, i) => {
    const flag = text(texts, section.required ? "ortak.zorunlu" : "ortak.opsiyonel");
    const lines = [
      `### ${i + 1}. ${section.title} [${flag}]`,
      `sections.${section.key} · ${formatHint(section, texts)}`,
    ];
    if (section.description) lines.push(section.description);
    lines.push(`🤖 ${section.aiInstruction}`);
    if (section.example) {
      lines.push(`${text(texts, "ortak.baslik.ornek")}:\n${section.example}`);
    }
    return lines.join("\n");
  });
  return [`${template.name} ${template.version}`, ...sections].join("\n\n");
}

export function renderTicketBlock(context: AnalysisContext, texts: PromptTexts): string {
  const t = context.ticket;
  const lines = [
    `${t.key} · ${t.issueType} · ${t.projectKey}`,
    `Başlık: ${t.summary}`,
    `Açıklama: ${t.description || "(boş)"}`,
    `Reporter: ${t.reporter}`,
    `Bileşenler: ${t.components.join(", ") || "-"}`,
    `Etiketler: ${t.labels.join(", ") || "-"}`,
  ];
  if (t.parentKey) lines.push(`Üst ticket: ${t.parentKey}`);
  if (context.clarifications.length > 0) {
    const rounds = context.clarifications.map(
      (c) => `${c.id} · S: ${c.question} · C: ${c.answer ?? "(cevaplanmadı)"}`,
    );
    lines.push(`\n${text(texts, "ortak.baslik.netlestirmeler")}:\n${bullets(rounds, "-")}`);
  }
  return lines.join("\n");
}

export function renderKnowledgeBlock(
  knowledge: KnowledgePack,
  discovery: AnalysisContext["discovery"],
  texts: PromptTexts,
): string {
  const empty = text(texts, "ortak.baglamBos");
  const cards = knowledge.repoCards.map(
    (c) => `${c.appId}: ${c.modules.map((m) => `${m.name} (${m.path}) — ${m.summary}`).join(" · ")}`,
  );
  const docs = knowledge.knowledgeDocs.map((d) => `${d.name}: ${d.text}`);
  const standards = knowledge.codingStandards.map((d) => `${d.name}: ${d.text}`);
  const examples = knowledge.exampleAnalyses.map((d) => `${d.name}:\n${d.text}`);

  return [
    block(
      `${text(texts, "ortak.baslik.repoDosyalari")} (${discovery.appId})`,
      bullets(discovery.files, empty),
    ),
    block(text(texts, "ortak.baslik.repoKartlari"), bullets(cards, empty)),
    block(text(texts, "ortak.baslik.knowledgeDokumanlari"), bullets(docs, empty)),
    block(text(texts, "ortak.baslik.kodlamaStandartlari"), bullets(standards, empty)),
    block(text(texts, "ortak.baslik.ornekAnalizler"), bullets(examples, empty)),
  ].join("\n\n");
}

export interface AnalysisPromptArgs {
  template: AnalysisTemplate;
  context: AnalysisContext;
  texts?: PromptTexts;
}

export function buildAnalysisPrompt(args: AnalysisPromptArgs): string {
  const texts = args.texts ?? DEFAULT_PROMPT_TEXTS;
  return [
    text(texts, "analyst.sistem"),
    block(
      text(texts, "ortak.baslik.kurallar"),
      bullets(
        [
          text(texts, "ortak.dil"),
          text(texts, "ortak.uydurmaYasak"),
          text(texts, "analyst.kurallar"),
          text(texts, "ortak.ciktiBicimi"),
        ],
        "-",
      ),
    ),
    block(text(texts, "ortak.baslik.sablon"), renderTemplateSpec(args.template, texts)),
    block(text(texts, "ortak.baslik.ticket"), renderTicketBlock(args.context, texts)),
    block(
      text(texts, "ortak.baslik.knowledge"),
      renderKnowledgeBlock(args.context.knowledge, args.context.discovery, texts),
    ),
    block(text(texts, "ortak.baslik.gorev"), text(texts, "analyst.gorev")),
  ].join("\n\n");
}

/**
 * The single repair round (M43): the model gets its own answer back with the
 * concrete list of what is missing. There is no second repair — the next
 * failure is an error, not another attempt.
 */
export function buildRepairPrompt(
  basePrompt: string,
  previous: unknown,
  deficiencies: readonly Deficiency[],
  texts: PromptTexts = DEFAULT_PROMPT_TEXTS,
): string {
  return [
    basePrompt,
    text(texts, "duzeltme.giris"),
    block(text(texts, "duzeltme.oncekiCevap"), JSON.stringify(previous, null, 2)),
    block(
      text(texts, "duzeltme.eksikBasligi"),
      bullets(
        deficiencies.map((d) => d.message),
        "-",
      ),
    ),
  ].join("\n\n");
}
