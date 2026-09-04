import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ReactNode } from "react";
import { ApiError, messageKeyOf } from "../api/errors.ts";
import { useApi } from "../auth/AuthProvider.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { Badge, Button, EmptyState, Input, Section, Table, useToast } from "../ui/index.ts";
import { dateTimeLabel } from "./shared/format.ts";
import { QueryState } from "./shared/QueryState.tsx";
import { SectionEditor } from "./template/SectionEditor.tsx";
import { SectionList } from "./template/SectionList.tsx";
import { TemplatePreview } from "./template/TemplatePreview.tsx";
import {
  addSection,
  canRemoveSection,
  isDirty,
  moveSection,
  newTemplateDraft,
  removeSection,
  renameTemplate,
  selectSection,
  toDraftSections,
  toWireSections,
  updateSection,
  type TemplateDraft,
  type TemplateHistoryEntry,
  type TemplateProjectBinding,
  type TemplateVersion,
} from "./template/model.ts";
import "./template/template.css";

interface TemplateResponse {
  readonly template: TemplateVersion;
  readonly history: readonly TemplateHistoryEntry[];
  readonly projects: readonly TemplateProjectBinding[];
}

/** `GET /template` on an installation that has published nothing yet. */
function isNoTemplate(error: unknown): boolean {
  return error instanceof ApiError && error.code === "no_template";
}

/**
 * Screen: template — the analysis template designer.
 *
 * The template is built here rather than uploaded: sections are added, removed
 * and ordered, and each one carries the title, description, AI instruction,
 * required flag, expected format and few-shot example that the server turns
 * into a Zod schema. Adding a section therefore needs no code change.
 *
 * Publishing creates a NEW version; runs already in flight finish on the
 * version they started with, which is why nothing here mutates a published
 * version in place — and why the publish button stays disabled while the draft
 * is identical to what is already published.
 */
export function TemplateScreen(): ReactNode {
  const { t, locale } = useI18n();
  const api = useApi();
  const toast = useToast();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["template"],
    queryFn: ({ signal }) => api.get<TemplateResponse>("/template", { signal }),
  });

  const [previewOpen, setPreviewOpen] = useState(false);

  /**
   * The editable draft, seeded from the server copy and re-seeded ONLY when the
   * published version changes.
   *
   * This is derived during render rather than in an effect, on purpose. Seeding
   * editable state from a query inside `useEffect` is the classic way to lose an
   * author's work: StrictMode double-invokes effects, and any refetch that
   * produces a new object identity re-runs them, so a half-typed section
   * silently disappears. Comparing the version we seeded from against the
   * version we just received makes the seed idempotent however many times React
   * renders or re-runs.
   *
   * A publish creates `version + 1`, so the new version re-seeds and picks up
   * the server's canonical copy; a refetch that still reports the same version
   * leaves the in-progress draft alone.
   */
  const published = query.data?.template ?? null;
  const [draft, setDraft] = useState<TemplateDraft | null>(null);
  const [seededVersion, setSeededVersion] = useState<number | null>(null);

  if (published !== null && seededVersion !== published.version) {
    setSeededVersion(published.version);
    setDraft({
      name: published.name,
      version: published.version,
      sections: toDraftSections(published.sections),
      selectedId: null,
    });
  }

  const publish = useMutation({
    mutationFn: (next: TemplateDraft) =>
      api.post<TemplateVersion>("/template/versions", {
        name: next.name,
        sections: toWireSections(next.sections),
      }),
    onSuccess: (record) => {
      toast.show(
        "success",
        t("template.saved", {
          name: record.name,
          version: String(record.version),
          n: String(record.sections.length),
        }),
      );
      void queryClient.invalidateQueries({ queryKey: ["template"] });
    },
    onError: (error) => toast.show("error", t(messageKeyOf(error))),
  });

  /**
   * "No template yet" is not a failure of this screen; it is the state the
   * screen exists to get the operator out of. It renders as a first-run panel
   * whose one action seeds a local draft, and the first publish makes version 1.
   */
  const noTemplate = isNoTemplate(query.error);
  const dirty = draft !== null && (published === null || isDirty(draft, published));
  const selected = draft?.sections.find((s) => s.id === draft.selectedId);
  const selectedIndex = draft?.sections.findIndex((s) => s.id === draft.selectedId) ?? -1;
  const projects = query.data?.projects ?? [];
  const history = query.data?.history ?? [];

  return (
    <QueryState
      isPending={query.isPending}
      error={noTemplate ? null : query.error}
      onRetry={() => void query.refetch()}
    >
      {draft === null ? (
        noTemplate && (
          <EmptyState
            title={t("template.none_title")}
            description={t("template.none_desc")}
            action={
              <Button
                variant="primary"
                onClick={() =>
                  setDraft(
                    newTemplateDraft(t("template.default_name"), {
                      title: t("template.first_section"),
                      aiInstruction: t("template.first_section_instruction"),
                    }),
                  )
                }
              >
                {t("template.create_first")}
              </Button>
            }
          />
        )
      ) : (
        <div className="scr-stack">
          <div className="tpl-bar">
            <div className="tpl-bar__name">
              <Input
                label={t("template.field.name")}
                value={draft.name}
                onChange={(event) => setDraft(renameTemplate(draft, event.target.value))}
              />
            </div>
            <div className="tpl-bar__actions">
              {published !== null && (
                <Badge tone="blue">{t("template.version_n", { n: String(published.version) })}</Badge>
              )}
              {dirty && published !== null && <Badge tone="amber">{t("template.unsaved")}</Badge>}
              <Button size="sm" onClick={() => setPreviewOpen(true)}>
                {t("template.preview")}
              </Button>
              <Button
                size="sm"
                variant="primary"
                busy={publish.isPending}
                disabled={!dirty}
                onClick={() => publish.mutate(draft)}
              >
                {published === null ? t("template.publish_first") : t("template.save_as_new_version")}
              </Button>
            </div>
          </div>

          {projects.length > 0 && (
            <div className="scr-chips">
              <span className="tpl-row__key">{t("template.used_by")}</span>
              {projects.map((binding) => (
                <Badge key={binding.projectKey} tone={binding.pinnedRuns > 0 ? "amber" : "gray"}>
                  {binding.pinnedRuns > 0
                    ? t("template.project_pinned", {
                        project: binding.projectKey,
                        version: String(binding.version),
                        n: String(binding.pinnedRuns),
                      })
                    : t("template.project_version", {
                        project: binding.projectKey,
                        version: String(binding.version),
                      })}
                </Badge>
              ))}
            </div>
          )}

          {/* What the engine actually reads from this screen — titles and AI
              instructions — and what it does not (the section skeleton). Said
              once, quietly, rather than as a warning strip. */}
          <p className="scr-hint">{t("template.unwired_note")}</p>

          <div className="tpl-split">
            <Section
              title={t("template.sections_n", { n: String(draft.sections.length) })}
              actions={
                <Button
                  size="sm"
                  onClick={() =>
                    setDraft(
                      addSection(draft, {
                        title: t("template.new_section"),
                        aiInstruction: t("template.new_section_instruction"),
                      }),
                    )
                  }
                >
                  {t("template.add_section")}
                </Button>
              }
            >
              <SectionList
                sections={draft.sections}
                selectedId={draft.selectedId}
                canRemove={canRemoveSection(draft)}
                onSelect={(id) => setDraft(selectSection(draft, id))}
                onMove={(id, delta) => setDraft(moveSection(draft, id, delta))}
                onRemove={(id) => {
                  if (!canRemoveSection(draft)) {
                    toast.show("error", t("template.last_section"));
                    return;
                  }
                  setDraft(removeSection(draft, id));
                }}
              />
              <p className="scr-keyline">{t("template.order_note")}</p>
            </Section>

            <SectionEditor
              section={selected}
              index={selectedIndex}
              onChange={(id, field, value) => setDraft(updateSection(draft, id, field, value))}
            />
          </div>

          {published !== null && (
            <Section title={t("template.history")}>
              <Table
                columns={[
                  {
                    key: "version",
                    header: t("template.col.version"),
                    cell: (row: TemplateHistoryEntry) => (
                      <Badge tone="blue">{t("template.version_n", { n: String(row.version) })}</Badge>
                    ),
                  },
                  { key: "at", header: t("template.col.at"), cell: (row) => dateTimeLabel(row.at, locale) },
                  { key: "author", header: t("template.col.author"), cell: (row) => row.author },
                  { key: "summary", header: t("template.col.summary"), cell: (row) => row.summary },
                ]}
                rows={history}
                rowKey={(row) => String(row.version)}
                emptyLabel={t("template.no_history")}
              />
              <p className="scr-hint">{t("template.pin_note")}</p>
            </Section>
          )}

          <TemplatePreview
            open={previewOpen}
            onClose={() => setPreviewOpen(false)}
            name={draft.name}
            version={draft.version}
            sections={draft.sections}
          />
        </div>
      )}
    </QueryState>
  );
}
