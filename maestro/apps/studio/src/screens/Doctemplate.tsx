import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import type { ChangeEvent, ReactNode } from "react";
import { messageKeyOf } from "../api/errors.ts";
import { useApi, useAuth } from "../auth/AuthProvider.tsx";
import { hasRole } from "../auth/types.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { Badge, Button, Section, Table, useToast } from "../ui/index.ts";
import { usePhrase } from "./common/label.ts";
import { dateTimeLabel } from "./shared/format.ts";
import { QueryState } from "./shared/QueryState.tsx";

/**
 * Screen: doctemplate — the corporate Word document template.
 *
 * The analysis is placed INSIDE the institution's own .docx: cover, header and
 * footer, logo slot, styles and the approval table all come from the uploaded
 * file; Maestro only fills placeholders. This screen shows which placeholders
 * were recognised, which are missing, and which analysis sections map to which
 * {{bolum:N}} slot.
 *
 * When no template is uploaded, generation does NOT stop — it falls back to a
 * plain default cover — but that is surfaced as a visible note here rather
 * than passing silently.
 */

/** Placeholder found (or not) in the uploaded .docx. */
interface Placeholder {
  readonly token: string;
  /** Catalog key describing what gets written here. */
  readonly descriptionKey: string;
  /** Where in the document it sits, as free text from the scan. */
  readonly location: string;
  readonly found: boolean;
}

interface DocTemplateFile {
  readonly fileName: string;
  readonly version: number;
  readonly uploadedAt: string;
  readonly uploadedBy: string;
  readonly sizeBytes: number;
  /** Style names read out of the .docx. */
  readonly styles: readonly string[];
}

interface SectionMapping {
  readonly index: number;
  readonly title: string;
  readonly token: string;
  /** False when the .docx has no slot — the section is appended at the end. */
  readonly mapped: boolean;
}

interface DocTemplateOutput {
  readonly fileName: string;
  readonly at: string;
  readonly templateVersion: number;
}

interface DocTemplateResponse {
  /** null when the institution has not uploaded a template yet. */
  readonly template: DocTemplateFile | null;
  readonly placeholders: readonly Placeholder[];
  readonly sectionMapping: readonly SectionMapping[];
  readonly outputs: readonly DocTemplateOutput[];
}

/**
 * One row of the merged placeholder table: the fixed placeholders (title,
 * ticket, run, …) and the per-section slots side by side. The scan reports a
 * section slot twice — once as a placeholder, once as a mapping — and showing
 * both lists made the page twice as long as its content.
 */
interface MappingRow {
  readonly token: string;
  readonly what: string;
  readonly where: string;
  readonly ok: boolean;
  readonly status: string;
}

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export function DoctemplateScreen(): ReactNode {
  const { t, locale } = useI18n();
  const phrase = usePhrase();
  const api = useApi();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { session } = useAuth();
  // Reading is admin + tech-lead; replacing the institution's template is admin
  // alone (apps/bff/src/routes/doc-template.ts). The button follows the BFF.
  const isAdmin = hasRole(session, "admin");
  const fileInput = useRef<HTMLInputElement>(null);

  const query = useQuery({
    queryKey: ["doctemplate"],
    queryFn: ({ signal }) => api.get<DocTemplateResponse>("/doc-template", { signal }),
  });

  const data = query.data;
  const template = data?.template ?? null;
  const outputs = data?.outputs ?? [];

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const bytes = await file.arrayBuffer();
      // The name travels in a header and the bytes go up verbatim.
      return api.postBinary<DocTemplateResponse>("/doc-template", bytes, {
        "content-type": DOCX_MIME,
        "x-maestro-filename": file.name,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["doctemplate"] });
      toast.show("success", t("doctemplate.toast.uploaded"));
    },
    onError: (error) => toast.show("error", t(messageKeyOf(error))),
  });

  const onPick = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    // Reset so picking the same file twice still fires a change event.
    event.target.value = "";
    if (file === undefined) return;
    if (!file.name.toLowerCase().endsWith(".docx")) {
      toast.show("error", t("doctemplate.error.not_docx"));
      return;
    }
    upload.mutate(file);
  };

  const download = async (version: number, fileName: string): Promise<void> => {
    try {
      const blob = await api.getBlob(`/doc-template/versions/${String(version)}/file`);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast.show("error", t(messageKeyOf(error)));
    }
  };

  /**
   * Merge the scan into one table. Section slots come from `sectionMapping`
   * (which knows the section title); their location, when the scan found one,
   * comes from the matching placeholder. Fixed placeholders are everything else.
   */
  const mapping = data?.sectionMapping ?? [];
  const sectionTokens = new Set(mapping.map((row) => row.token));
  const rows: readonly MappingRow[] = [
    ...(data?.placeholders ?? [])
      .filter((row) => !sectionTokens.has(row.token))
      .map((row) => ({
        token: row.token,
        what: phrase(row.descriptionKey),
        where: row.location,
        ok: row.found,
        status: row.found ? t("doctemplate.found") : t("doctemplate.not_in_template"),
      })),
    ...mapping.map((row) => {
      const scanned = data?.placeholders.find((one) => one.token === row.token);
      return {
        token: row.token,
        what: t("doctemplate.section_row", { n: String(row.index), title: row.title }),
        where: scanned?.location ?? "",
        ok: row.mapped,
        status: row.mapped ? t("doctemplate.mapped") : t("doctemplate.appended"),
      };
    }),
  ];
  const missing = rows.filter((row) => !row.ok).length;
  const mappingSub =
    template === null
      ? t("doctemplate.mapping_none")
      : missing > 0
        ? t("doctemplate.missing_n", { n: String(missing) })
        : t("doctemplate.all_found");

  return (
    <div className="scr-stack">
      <Section
        title={t("doctemplate.file")}
        subtitle={t("doctemplate.file_sub")}
        actions={
          isAdmin ? (
            <>
              <input
                ref={fileInput}
                type="file"
                accept=".docx"
                hidden
                tabIndex={-1}
                aria-label={t("doctemplate.action.upload")}
                onChange={onPick}
              />
              <Button
                variant="primary"
                size="sm"
                busy={upload.isPending}
                onClick={() => fileInput.current?.click()}
              >
                {t("doctemplate.action.upload")}
              </Button>
            </>
          ) : undefined
        }
      >
        <QueryState isPending={query.isPending} error={query.error} onRetry={() => void query.refetch()}>
          {template === null ? (
            <p className="scr-hint">
              <Badge tone="gray">{t("doctemplate.none_badge")}</Badge> {t("doctemplate.none")}
              {!isAdmin && <> {t("doctemplate.upload_admin_only")}</>}
            </p>
          ) : (
            <>
              <div className="scr-row">
                <b>{template.fileName}</b>
                <Badge tone="blue">{t("doctemplate.version_n", { n: String(template.version) })}</Badge>
                <Button size="sm" onClick={() => void download(template.version, template.fileName)}>
                  {t("doctemplate.action.download")}
                </Button>
              </div>
              <p className="scr-keyline">
                {t("doctemplate.uploaded_meta", {
                  at: dateTimeLabel(template.uploadedAt, locale),
                  by: template.uploadedBy,
                  kb: String(Math.round(template.sizeBytes / 1024)),
                })}
                {!isAdmin && <> · {t("doctemplate.upload_admin_only")}</>}
              </p>
              {template.styles.length > 0 && (
                <div className="scr-chips">
                  <span className="scr-keyline">{t("doctemplate.styles")}</span>
                  {template.styles.map((style) => (
                    <Badge key={style} tone="gray">
                      {style}
                    </Badge>
                  ))}
                </div>
              )}
            </>
          )}

          {outputs.length > 0 && (
            <div>
              <p className="scr-keyline">{t("doctemplate.outputs")}</p>
              {outputs.map((output) => (
                <div className="scr-file" key={output.fileName}>
                  <span className="scr-file__name">{output.fileName}</span>
                  <span className="scr-keyline">{dateTimeLabel(output.at, locale)}</span>
                  <Badge tone="gray">
                    {t("doctemplate.version_n", { n: String(output.templateVersion) })}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </QueryState>
      </Section>

      <Section title={t("doctemplate.mapping")} subtitle={query.data === undefined ? undefined : mappingSub}>
        <QueryState
          isPending={query.isPending}
          error={query.error}
          isEmpty={rows.length === 0}
          emptyTitle={t("doctemplate.no_mapping")}
        >
          <Table
            columns={[
              {
                key: "token",
                header: t("doctemplate.col.token"),
                cell: (row: MappingRow) => <code>{row.token}</code>,
              },
              { key: "what", header: t("doctemplate.col.what"), cell: (row) => row.what },
              { key: "where", header: t("doctemplate.col.where"), cell: (row) => row.where },
              {
                key: "status",
                header: t("doctemplate.col.status"),
                cell: (row) => <Badge tone={row.ok ? "green" : "amber"}>{row.status}</Badge>,
              },
            ]}
            rows={rows}
            rowKey={(row) => row.token}
            emptyLabel={t("doctemplate.no_mapping")}
          />
        </QueryState>
        <p className="scr-hint">{t("doctemplate.standard_note")}</p>
      </Section>
    </div>
  );
}
