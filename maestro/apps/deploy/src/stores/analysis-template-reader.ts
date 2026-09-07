import type { AnalysisTemplateReader } from "@maestro/workflows";
import type { TemplateStore } from "@maestro/bff";

/**
 * The published Studio analysis template, for the analyst's instructions and
 * the document's section headings (see `AnalysisTemplateReader` in the
 * workflows core). Reads the version the run is PINNED to (M83): a template
 * published mid-run must not change what a running analysis is told. An
 * unparseable version string or a missing row is `null` — the analyst then
 * works from the schema alone and says so in the worker log.
 */
export function analysisTemplateReaderFor(store: TemplateStore): AnalysisTemplateReader {
  return {
    sections: async (version) => {
      const number = Number(version);
      const record = Number.isInteger(number) && number > 0 ? await store.get(number) : await store.latest();
      if (record === null) return null;
      return record.sections.map((section) => ({
        key: section.key,
        title: section.title,
        aiInstruction: section.aiInstruction,
      }));
    },
  };
}
