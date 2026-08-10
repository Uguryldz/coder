import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ReactNode } from "react";
import { useSearchParams } from "react-router";
import type { LlmRole } from "@maestro/contracts";
import { messageKeyOf } from "../api/errors.ts";
import { useApi } from "../auth/AuthProvider.tsx";
import { useAuth } from "../auth/AuthProvider.tsx";
import { hasRole } from "../auth/types.ts";
import { useT } from "../i18n/I18nProvider.tsx";
import { Badge, Button, Card, EmptyState, Input, Modal, TabPanel, Table, Tabs, useToast } from "../ui/index.ts";
import { useEnumLabel } from "./common/label.ts";
import { MaybeUnwired } from "./shared/unwired.tsx";
import { TextArea } from "./shared/TextArea.tsx";
import { parseKnowledge } from "./Variants.tsx";

/**
 * Screen: variant — one agent variant in detail (persona, knowledge, versions).
 *
 * Which variant is shown comes from `?id=`; without it the screen says so
 * rather than silently picking one, because "the first variant in the list" is
 * not the variant the operator asked for.
 *
 * An admin edits the platform overlay in place, and publishes a NEW version to
 * change the model or persona — a published version is never rewritten (M83), so
 * the persona editor on the persona tab stays read-only and the "publish
 * version" modal is where a change is made. The BFF enforces both the admin gate
 * and the append-only rule regardless of what this UI shows.
 */

interface VariantVersion {
  readonly version: number;
  readonly publishedAt: string;
  readonly publishedBy: string;
  readonly note: string;
  readonly evalScore: number | null;
}

interface KnowledgeLink {
  readonly docId: string;
  readonly fileName: string;
  readonly category: string;
  readonly version: number;
}

interface VariantDetail {
  readonly variantId: string;
  readonly role: LlmRole;
  readonly platform: string;
  readonly model: string;
  readonly activeVersion: number;
  readonly persona: string;
  readonly knowledge: readonly KnowledgeLink[];
  readonly versions: readonly VariantVersion[];
}

export function VariantScreen(): ReactNode {
  const t = useT();
  const api = useApi();
  const { session } = useAuth();
  const enumLabel = useEnumLabel();
  const [params] = useSearchParams();
  const variantId = params.get("id");
  const [tab, setTab] = useState("persona");
  const [editing, setEditing] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const isAdmin = hasRole(session, "admin");

  const query = useQuery({
    queryKey: ["variant", variantId],
    enabled: variantId !== null,
    queryFn: ({ signal }) =>
      api.get<VariantDetail>(`/variants/${encodeURIComponent(variantId ?? "")}`, { signal }),
  });

  if (variantId === null) {
    return (
      <Card title={t("variant.detail")}>
        <EmptyState icon="🤖" title={t("variant.pick_first")} description={t("variant.pick_hint")} />
      </Card>
    );
  }

  const data = query.data;

  return (
    <Card
      title={data === undefined ? t("variant.detail") : data.variantId}
      subtitle={
        data === undefined
          ? undefined
          : t("variant.subtitle", {
              role: enumLabel("llm.role", data.role).text,
              platform: data.platform,
              version: String(data.activeVersion),
            })
      }
      actions={
        isAdmin && data !== undefined ? (
          <div className="tpl-bar__actions">
            <Button size="sm" onClick={() => setEditing(true)}>
              {t("variant.action.edit_platform")}
            </Button>
            <Button size="sm" variant="primary" onClick={() => setPublishing(true)}>
              {t("variant.action.publish_version")}
            </Button>
          </div>
        ) : undefined
      }
    >
      <MaybeUnwired isPending={query.isPending} error={query.error} onRetry={() => void query.refetch()}>
        {data !== undefined && (
          <>
            <Tabs
              label={t("variant.tabs")}
              active={tab}
              onChange={setTab}
              items={[
                { id: "persona", label: t("variant.tab.persona") },
                { id: "knowledge", label: t("variant.tab.knowledge"), count: data.knowledge.length },
                { id: "versions", label: t("variant.tab.versions"), count: data.versions.length },
              ]}
            />

            <TabPanel id="persona" active={tab}>
              <TextArea
                label={t("variant.persona")}
                rows={14}
                readOnly
                value={data.persona}
                hint={t("variant.persona_readonly")}
              />
              <p className="tpl-keyline">{t("variant.model_is", { model: data.model })}</p>
            </TabPanel>

            <TabPanel id="knowledge" active={tab}>
              <Table
                columns={[
                  {
                    key: "file",
                    header: t("knowledge.col.file"),
                    cell: (row: KnowledgeLink) => row.fileName,
                  },
                  {
                    key: "category",
                    header: t("knowledge.col.category"),
                    cell: (row) => <Badge tone="gray">{row.category}</Badge>,
                  },
                  {
                    key: "version",
                    header: t("knowledge.col.version"),
                    cell: (row) => <Badge tone="blue">v{row.version}</Badge>,
                  },
                ]}
                rows={data.knowledge}
                rowKey={(row) => row.docId}
                emptyLabel={t("variant.no_knowledge")}
              />
            </TabPanel>

            <TabPanel id="versions" active={tab}>
              <Table
                columns={[
                  {
                    key: "version",
                    header: t("variant.col.version"),
                    cell: (row: VariantVersion) => (
                      <Badge tone={row.version === data.activeVersion ? "green" : "gray"}>
                        v{row.version}
                      </Badge>
                    ),
                  },
                  { key: "at", header: t("variant.col.published_at"), cell: (row) => row.publishedAt },
                  { key: "by", header: t("variant.col.published_by"), cell: (row) => row.publishedBy },
                  {
                    key: "eval",
                    header: t("variant.col.eval"),
                    cell: (row) =>
                      row.evalScore === null
                        ? t("variants.never_evaluated")
                        : String(row.evalScore),
                    align: "right",
                  },
                  { key: "note", header: t("variant.col.note"), cell: (row) => row.note },
                ]}
                rows={data.versions}
                rowKey={(row) => String(row.version)}
                emptyLabel={t("variant.no_versions")}
              />
            </TabPanel>
          </>
        )}
      </MaybeUnwired>

      {editing && data !== undefined && (
        <EditPlatformModal
          variantId={data.variantId}
          current={data.platform}
          onClose={() => setEditing(false)}
        />
      )}
      {publishing && data !== undefined && (
        <PublishVersionModal
          variantId={data.variantId}
          current={data}
          onClose={() => setPublishing(false)}
        />
      )}
    </Card>
  );
}

function EditPlatformModal({
  variantId,
  current,
  onClose,
}: {
  readonly variantId: string;
  readonly current: string;
  readonly onClose: () => void;
}): ReactNode {
  const api = useApi();
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [platform, setPlatform] = useState(current);

  const save = useMutation({
    mutationFn: () =>
      api.put<VariantDetail>(`/variants/${encodeURIComponent(variantId)}`, {
        platform: platform.trim(),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["variant", variantId] });
      void queryClient.invalidateQueries({ queryKey: ["variants"] });
      toast.show("success", t("variant.toast.edited"));
      onClose();
    },
    onError: (error) => toast.show("error", t(messageKeyOf(error))),
  });

  const invalid = platform.trim() === "";

  return (
    <Modal
      open
      onClose={onClose}
      title={t("variant.edit.title")}
      closeLabel={t("action.close")}
      footer={
        <>
          <Button onClick={onClose}>{t("action.cancel")}</Button>
          <Button
            variant="primary"
            busy={save.isPending}
            onClick={() => {
              if (!invalid) save.mutate();
            }}
          >
            {t("variant.action.save")}
          </Button>
        </>
      }
    >
      <Input
        label={t("variants.field.platform")}
        value={platform}
        onChange={(event) => setPlatform(event.target.value)}
        hint={t("variant.edit.platform_hint")}
        {...(invalid ? { error: t("variants.error.platform") } : {})}
      />
      <div className="scr-note" style={{ marginTop: 8 }}>
        {t("variant.edit.model_note")}
      </div>
    </Modal>
  );
}

function PublishVersionModal({
  variantId,
  current,
  onClose,
}: {
  readonly variantId: string;
  readonly current: VariantDetail;
  readonly onClose: () => void;
}): ReactNode {
  const api = useApi();
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();

  // Seeded from the active version — a new version is usually an EDIT of the
  // last one, not a blank slate — but publishing writes a fresh version and
  // never rewrites the one seeded from (M83).
  const [model, setModel] = useState(current.model);
  const [persona, setPersona] = useState(current.persona);
  const [knowledge, setKnowledge] = useState(current.knowledge.map((k) => k.fileName).join("\n"));
  const [note, setNote] = useState("");

  const publish = useMutation({
    mutationFn: () =>
      api.post<VariantDetail>(`/variants/${encodeURIComponent(variantId)}/versions`, {
        model: model.trim(),
        persona,
        knowledgeRefs: parseKnowledge(knowledge),
        note: note.trim(),
      }),
    onSuccess: (detail) => {
      void queryClient.invalidateQueries({ queryKey: ["variant", variantId] });
      void queryClient.invalidateQueries({ queryKey: ["variants"] });
      toast.show("success", t("variant.toast.version_published", { n: String(detail.activeVersion) }));
      onClose();
    },
    onError: (error) => toast.show("error", t(messageKeyOf(error))),
  });

  const invalid = model.trim() === "";

  return (
    <Modal
      open
      onClose={onClose}
      title={t("variant.publish.title", { n: String(current.activeVersion + 1) })}
      closeLabel={t("action.close")}
      footer={
        <>
          <Button onClick={onClose}>{t("action.cancel")}</Button>
          <Button
            variant="primary"
            busy={publish.isPending}
            onClick={() => {
              if (!invalid) publish.mutate();
            }}
          >
            {t("variant.action.publish_version")}
          </Button>
        </>
      }
    >
      <Input
        label={t("variants.field.model")}
        value={model}
        onChange={(event) => setModel(event.target.value)}
        {...(invalid ? { error: t("variants.error.model") } : {})}
      />
      <TextArea
        label={t("variants.field.persona")}
        rows={10}
        value={persona}
        onChange={(event) => setPersona(event.target.value)}
        hint={t("variants.field.persona_hint")}
      />
      <TextArea
        label={t("variants.field.knowledge")}
        rows={3}
        value={knowledge}
        onChange={(event) => setKnowledge(event.target.value)}
        hint={t("variants.field.knowledge_hint")}
      />
      <Input
        label={t("variants.field.note")}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        hint={t("variant.publish.note_hint")}
      />
      <div className="scr-note" style={{ marginTop: 8 }}>
        {t("variant.publish.append_note")}
      </div>
    </Modal>
  );
}
