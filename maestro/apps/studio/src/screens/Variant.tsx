import { LoadTrainingButton } from "./Variants.tsx";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type { ReactNode } from "react";
import { Navigate, useLocation, useSearchParams } from "react-router";
import type { LlmRole } from "@maestro/contracts";
import { messageKeyOf } from "../api/errors.ts";
import { useApi } from "../auth/AuthProvider.tsx";
import { useAuth } from "../auth/AuthProvider.tsx";
import { hasAnyRole, hasRole } from "../auth/types.ts";
import { useI18n, useT } from "../i18n/I18nProvider.tsx";
import {
  Badge,
  Button,
  ButtonLink,
  Card,
  EmptyState,
  Input,
  Modal,
  TabPanel,
  Table,
  Tabs,
  TextArea,
  useToast,
} from "../ui/index.ts";
import { useEnumLabel } from "./common/label.ts";
import { fileToBase64 } from "./shared/file-base64.ts";
import { dateTimeLabel } from "./shared/format.ts";
import { QueryState } from "./shared/QueryState.tsx";
import { GuidanceList } from "./knowledge/GuidanceList.tsx";
import { GUIDANCE_QUERY_KEY, GUIDANCE_WRITE_ROLES, targetOf, type GuidanceNote } from "./knowledge/types.ts";
import { ModelField, useConnectionModels } from "./variants/ModelField.tsx";
import { variantModelHealth } from "./variants/model-source.ts";
import { useServedModels } from "./variants/use-served-models.ts";
import { isValidModel, isValidName, isValidNote, isValidPersona } from "./variants/validate.ts";

/**
 * Screen: variant — one agent definition in detail.
 *
 * Which agent is shown comes from `?id=`; without it the screen says so rather
 * than silently picking one. The path is `/variants/detail`, UNDER the list's
 * path, so the sidebar keeps "Ajan tanımları" lit and the back link above the
 * card goes where the operator came from.
 *
 * The name is edited in place; the model and persona are versioned — a change
 * is a NEW version (M83), never a rewrite — so the persona tab is read-only
 * and both "change the model" affordances open the same publish modal. The
 * BFF enforces the admin gate and the append-only rule regardless of the UI.
 *
 * The "Bilgi notları" tab is the agent-targeted slice of the guidance library.
 * The analysis step reads those notes (`packages/workflows/src/impl/guidance.ts`
 * → `writeAnalysis`), so what this tab promises is what the model sees.
 */

interface VariantVersion {
  readonly version: number;
  readonly publishedAt: string;
  readonly publishedBy: string;
  readonly note: string;
}

interface VariantDetail {
  readonly variantId: string;
  readonly role: LlmRole;
  /** The agent's display name (wire name kept for the BFF contract). */
  readonly platform: string;
  readonly model: string;
  readonly activeVersion: number;
  readonly persona: string;
  readonly versions: readonly VariantVersion[];
}

/** The old `/variant?id=` path — bookmarks land on the new one, query intact. */
export function VariantLegacyRedirect(): ReactNode {
  const { search } = useLocation();
  return <Navigate to={`/variants/detail${search}`} replace />;
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

  // The shared guidance library, filtered to the notes targeted at THIS agent.
  // Same query key as the library screen, so a write here refreshes there too.
  const guidance = useQuery({
    queryKey: GUIDANCE_QUERY_KEY,
    enabled: variantId !== null,
    retry: false,
    queryFn: ({ signal }) =>
      api.get<{ notes: readonly GuidanceNote[] }>("/studio/guidance", { signal }),
  });
  const targeted = (guidance.data?.notes ?? []).filter((note) => targetOf(note) === variantId);

  const back = (
    <ButtonLink variant="link" to="/variants">
      {t("variant.back")}
    </ButtonLink>
  );

  if (variantId === null) {
    return (
      <div className="scr-stack">
        {back}
        <Card title={t("variant.detail")}>
          <EmptyState icon="🤖" title={t("variant.pick_first")} description={t("variant.pick_hint")} />
        </Card>
      </div>
    );
  }

  const data = query.data;

  return (
    <div className="scr-stack">
      {back}
      <Card
        title={data === undefined ? t("variant.detail") : data.platform}
        subtitle={
          data === undefined
            ? undefined
            : t("variant.subtitle", {
                id: data.variantId,
                role: enumLabel("llm.role", data.role).text,
                version: String(data.activeVersion),
              })
        }
        actions={
          isAdmin && data !== undefined ? (
            <div className="scr-row">
              <Button size="sm" onClick={() => setEditing(true)}>
                {t("variant.action.edit_name")}
              </Button>
              <Button size="sm" variant="primary" onClick={() => setPublishing(true)}>
                {t("variant.action.publish_version")}
              </Button>
            </div>
          ) : undefined
        }
      >
        <QueryState isPending={query.isPending} error={query.error} onRetry={() => void query.refetch()}>
          {data !== undefined && (
            <div className="scr-stack">
              <dl className="scr-kv">
                <dt>{t("variants.col.role")}</dt>
                <dd>{enumLabel("llm.role", data.role).text}</dd>
                <dt>{t("variants.col.model")}</dt>
                <dd>
                  <VariantModelLine model={data.model} canChange={isAdmin} onChange={() => setPublishing(true)} />
                </dd>
              </dl>

              <Tabs
                label={t("variant.tabs")}
                active={tab}
                onChange={setTab}
                items={[
                  { id: "persona", label: t("variant.tab.persona") },
                  { id: "knowledge", label: t("variant.tab.knowledge"), count: targeted.length },
                  { id: "versions", label: t("variant.tab.versions"), count: data.versions.length },
                ]}
              />

              <TabPanel id="persona" active={tab}>
                {data.persona.trim() === "" ? (
                  <p className="scr-hint">{t("variant.persona_empty")}</p>
                ) : (
                  <TextArea
                    label={t("variant.persona")}
                    rows={10}
                    readOnly
                    value={data.persona}
                    hint={t("variant.persona_readonly")}
                  />
                )}
              </TabPanel>

              <TabPanel id="knowledge" active={tab}>
                <VariantGuidance
                  variantId={data.variantId}
                  notes={targeted}
                  isPending={guidance.isPending}
                  error={guidance.error}
                  onRetry={() => void guidance.refetch()}
                />
              </TabPanel>

              <TabPanel id="versions" active={tab}>
                <VersionTable versions={data.versions} activeVersion={data.activeVersion} />
              </TabPanel>
            </div>
          )}
        </QueryState>
      </Card>

      {editing && data !== undefined && (
        <EditNameModal
          variantId={data.variantId}
          current={data.platform}
          onClose={() => setEditing(false)}
          // One click to the right window: the edit closes, publishing opens.
          onChangeModel={() => {
            setEditing(false);
            setPublishing(true);
          }}
        />
      )}
      {publishing && data !== undefined && (
        <PublishVersionModal variantId={data.variantId} current={data} onClose={() => setPublishing(false)} />
      )}
    </div>
  );
}

function VersionTable({
  versions,
  activeVersion,
}: {
  readonly versions: readonly VariantVersion[];
  readonly activeVersion: number;
}): ReactNode {
  const t = useT();
  const { locale } = useI18n();
  return (
    <Table
      columns={[
        {
          key: "version",
          header: t("variant.col.version"),
          cell: (row: VariantVersion) => (
            <Badge tone={row.version === activeVersion ? "green" : "gray"}>v{row.version}</Badge>
          ),
        },
        { key: "at", header: t("variant.col.published_at"), cell: (row) => dateTimeLabel(row.publishedAt, locale) },
        { key: "by", header: t("variant.col.published_by"), cell: (row) => row.publishedBy },
        { key: "note", header: t("variant.col.note"), cell: (row) => row.note },
      ]}
      rows={versions}
      rowKey={(row) => String(row.version)}
      emptyLabel={t("variant.no_versions")}
    />
  );
}

/**
 * The model line — where the operator SEES the model is where they change it.
 * A problematic name (unset, or a cloud model on an offline install) is flagged
 * right here, with the same judgement `auditVariantModels` uses server-side.
 */
function VariantModelLine({
  model,
  canChange,
  onChange,
}: {
  readonly model: string;
  readonly canChange: boolean;
  readonly onChange: () => void;
}): ReactNode {
  const t = useT();
  const served = useServedModels();
  const health = variantModelHealth(model, served);

  return (
    <div className="scr-stack">
      <span className="scr-row">
        <code>{model}</code>
        {health === "unset" && <Badge tone="amber">{t("variants.model.unset_badge")}</Badge>}
        {health === "cloud" && <Badge tone="red">{t("variants.model.cloud_badge")}</Badge>}
        {canChange && (
          <Button variant="link" size="sm" onClick={onChange}>
            {t("variant.model.change")}
          </Button>
        )}
      </span>
      {health !== "ok" && (
        <span className="scr-hint">
          {health === "unset" ? t("variants.model.unset_hint") : t("variants.model.cloud_hint")}
        </span>
      )}
    </div>
  );
}

/**
 * "Bu ajana belge yükle" — the targeted knowledge of ONE agent. A document
 * uploaded here becomes a guidance note with `variantId` set, so only this
 * agent's analyses see it; the library screen's upload is where a note for
 * every agent goes.
 */
function VariantGuidance({
  variantId,
  notes,
  isPending,
  error,
  onRetry,
}: {
  readonly variantId: string;
  readonly notes: readonly GuidanceNote[];
  readonly isPending: boolean;
  readonly error: unknown;
  readonly onRetry: () => void;
}): ReactNode {
  const t = useT();
  const api = useApi();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const canWrite = hasAnyRole(session, GUIDANCE_WRITE_ROLES);
  const fileInput = useRef<HTMLInputElement>(null);

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const contentBase64 = await fileToBase64(file);
      return api.post<{ note: GuidanceNote }>("/studio/guidance/upload", {
        fileName: file.name,
        contentBase64,
        variantId,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: GUIDANCE_QUERY_KEY });
      toast.show("success", t("variant.knowledge.toast.uploaded"));
    },
    onError: (err) => toast.show("error", t(messageKeyOf(err))),
  });

  const pickFile = (files: FileList | null): void => {
    const file = files?.[0];
    // Reset so choosing the same file again re-fires the change event.
    if (fileInput.current !== null) fileInput.current.value = "";
    if (file === undefined) return;
    upload.mutate(file);
  };

  return (
    <div className="scr-stack">
      <p className="scr-hint">{t("variant.knowledge.targeted_hint")}</p>
      {canWrite && (
        <div className="scr-row">
          <input
            ref={fileInput}
            type="file"
            accept=".md,.txt,.docx"
            hidden
            onChange={(event) => pickFile(event.target.files)}
            aria-hidden="true"
            tabIndex={-1}
          />
          <Button variant="primary" size="sm" busy={upload.isPending} onClick={() => fileInput.current?.click()}>
            {t("variant.knowledge.action.upload")}
          </Button>
          <span className="scr-hint">{t("guidance.upload_hint")}</span>
        </div>
      )}
      <GuidanceList
        notes={notes}
        canWrite={canWrite}
        showScope={false}
        isPending={isPending}
        error={error}
        emptyLabel={t("variant.knowledge.targeted_empty")}
        onRetry={onRetry}
      />
    </div>
  );
}

/**
 * Edits the agent's NAME in place. The model and persona are not here — they
 * are versioned — but the button to the publish modal is, because this is the
 * window an operator opens first when they want to change the model.
 */
function EditNameModal({
  variantId,
  current,
  onClose,
  onChangeModel,
}: {
  readonly variantId: string;
  readonly current: string;
  readonly onClose: () => void;
  readonly onChangeModel: () => void;
}): ReactNode {
  const api = useApi();
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [name, setName] = useState(current);
  const [touched, setTouched] = useState(false);

  const save = useMutation({
    mutationFn: () =>
      api.put<VariantDetail>(`/variants/${encodeURIComponent(variantId)}`, { platform: name.trim() }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["variant", variantId] });
      void queryClient.invalidateQueries({ queryKey: ["variants"] });
      toast.show("success", t("variant.toast.edited"));
      onClose();
    },
    onError: (error) => toast.show("error", t(messageKeyOf(error))),
  });

  const invalid = !isValidName(name);

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
              setTouched(true);
              if (!invalid) save.mutate();
            }}
          >
            {t("variant.action.save")}
          </Button>
        </>
      }
    >
      <Input
        label={t("variants.field.name")}
        value={name}
        onChange={(event) => setName(event.target.value)}
        hint={t("variants.field.name_hint")}
        {...(touched && invalid ? { error: t("variants.error.name") } : {})}
      />
      <div className="scr-note">
        <div className="scr-stack">
          <span>{t("variant.edit.model_note")}</span>
          <span>
            <Button size="sm" onClick={onChangeModel}>
              {t("variant.model.change_go")}
            </Button>
          </span>
        </div>
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
  // last one — but publishing writes a fresh version and never rewrites the
  // one it was seeded from (M83).
  const [model, setModel] = useState(current.model);
  const [persona, setPersona] = useState(current.persona);
  const modelOptions = useConnectionModels();
  const [note, setNote] = useState("");
  const [touched, setTouched] = useState(false);

  const errors = {
    model: !isValidModel(model),
    persona: !isValidPersona(persona),
    note: !isValidNote(note),
  };
  const blocked = Object.values(errors).some(Boolean);

  const publish = useMutation({
    mutationFn: () =>
      api.post<VariantDetail>(`/variants/${encodeURIComponent(variantId)}/versions`, {
        model: model.trim(),
        persona,
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
              setTouched(true);
              if (!blocked) publish.mutate();
            }}
          >
            {t("variant.action.publish_version")}
          </Button>
        </>
      }
    >
      <ModelField
        value={model}
        onChange={setModel}
        options={modelOptions}
        hint={t("variants.field.model_hint")}
        {...(touched && errors.model ? { error: t("variants.error.model") } : {})}
      />
      <TextArea
        label={t("variants.field.persona")}
        rows={8}
        value={persona}
        onChange={(event) => setPersona(event.target.value)}
        hint={t("variants.field.persona_hint")}
        {...(touched && errors.persona ? { error: t("variants.error.persona") } : {})}
      />
      <LoadTrainingButton role={current.role} onLoaded={setPersona} />
      <Input
        label={t("variants.field.note")}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        hint={t("variant.publish.note_hint")}
        {...(touched && errors.note ? { error: t("variants.error.note") } : {})}
      />
    </Modal>
  );
}
