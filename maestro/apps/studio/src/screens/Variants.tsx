import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router";
import type { LlmRole } from "@maestro/contracts";
import { messageKeyOf } from "../api/errors.ts";
import { useApi } from "../auth/AuthProvider.tsx";
import { useAuth } from "../auth/AuthProvider.tsx";
import { hasRole } from "../auth/types.ts";
import { useT } from "../i18n/I18nProvider.tsx";
import { Badge, Button, Card, Input, Modal, Select, Table, TextArea, useToast } from "../ui/index.ts";
import { useEnumLabel } from "./common/label.ts";
import { ModelField, useConnectionModels } from "./variants/ModelField.tsx";
import { variantModelHealth } from "./variants/model-source.ts";
import {
  isValidModel,
  isValidName,
  isValidNote,
  isValidPersona,
  isValidVariantId,
} from "./variants/validate.ts";
import { QueryState } from "./shared/QueryState.tsx";

/**
 * Screen: variants — the agent definitions ("Ajan tanımları").
 *
 * One row per agent: id, name, role, model, active version. Versions are
 * immutable (M83): a new version is published, running workflows finish on the
 * version they started with. Creating is admin-only here and on the BFF.
 *
 * The wire field `platform` IS the agent's display name (`write-variants.ts`
 * stores it as `Variant.name`; the seed writes "Analiz ajanı (varsayılan)"). It
 * used to be labelled "Platform" with a "web · mobile-ios…" hint and a "web"
 * default, so every seeded agent was called "web". The wire name stays; the
 * operator sees "Ajan adı".
 */

export interface AgentVariant {
  readonly variantId: string;
  readonly role: LlmRole;
  /** The agent's display name (wire name kept for the BFF contract). */
  readonly platform: string;
  readonly model: string;
  readonly activeVersion: number;
}

/**
 * The roles an agent definition can serve — the customer's four-agent chain.
 * The analyst (which also serves intake and the read-only repo discovery) and
 * the engineer are pinned per run (`run-pins.ts`); the planner and the
 * verifier (`dev_reviewer`) are resolved by ROLE, lowest id first. The test
 * roles have no agent definition and are not offered.
 */
const PINNED_ROLES: readonly LlmRole[] = ["analyst", "planner", "engineer", "dev_reviewer"];

export function VariantsScreen(): ReactNode {
  const t = useT();
  const api = useApi();
  const { session } = useAuth();
  const enumLabel = useEnumLabel();
  const navigate = useNavigate();
  const isAdmin = hasRole(session, "admin");
  const [creating, setCreating] = useState(false);

  const query = useQuery({
    queryKey: ["variants"],
    queryFn: ({ signal }) => api.get<{ variants: readonly AgentVariant[] }>("/variants", { signal }),
  });

  return (
    <>
      <Card
        title={t("variants.catalogue")}
        subtitle={t("variants.catalogue_sub")}
        padded={false}
        actions={
          isAdmin ? (
            <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
              {t("variants.action.add")}
            </Button>
          ) : undefined
        }
      >
        <QueryState
          isPending={query.isPending}
          error={query.error}
          isEmpty={(query.data?.variants ?? []).length === 0}
          emptyTitle={t("variants.empty")}
          onRetry={() => void query.refetch()}
        >
          <ModelHealthBanner variants={query.data?.variants ?? []} />
          <Table
            columns={[
              {
                key: "name",
                header: t("variants.col.name"),
                cell: (row: AgentVariant) => row.platform,
              },
              { key: "id", header: t("variants.col.variant"), cell: (row) => <code>{row.variantId}</code> },
              {
                key: "role",
                header: t("variants.col.role"),
                cell: (row) => enumLabel("llm.role", row.role).text,
              },
              {
                key: "model",
                header: t("variants.col.model"),
                cell: (row) => <ModelCell model={row.model} />,
              },
              {
                key: "version",
                header: t("variants.col.version"),
                cell: (row) => <Badge tone="blue">v{row.activeVersion}</Badge>,
                align: "right",
              },
            ]}
            rows={query.data?.variants ?? []}
            rowKey={(row) => row.variantId}
            onRowClick={(row) => void navigate(`/variants/detail?id=${encodeURIComponent(row.variantId)}`)}
            emptyLabel={t("variants.empty")}
          />
        </QueryState>
      </Card>

      {creating && (
        <CreateVariantModal
          onClose={() => setCreating(false)}
          onCreated={(variantId) => {
            setCreating(false);
            void navigate(`/variants/detail?id=${encodeURIComponent(variantId)}`);
          }}
        />
      )}
    </>
  );
}

/**
 * Listenin üstünde duran özet: kaç ajanın modeli eksik/erişilemez ve NE
 * YAPILACAĞI. Hiçbir bulgu yoksa hiçbir şey çizilmez — temiz bir kurulumda
 * okunacak bir uyarı, gerçek bir uyarının fark edilme şansını düşürür.
 */
function ModelHealthBanner({ variants }: { readonly variants: readonly AgentVariant[] }): ReactNode {
  const t = useT();
  const flagged = variants.filter((row) => variantModelHealth(row.model) !== "ok");
  if (flagged.length === 0) return null;

  const cloud = flagged.filter((row) => variantModelHealth(row.model) === "cloud");
  return (
    <div className={cloud.length > 0 ? "scr-note scr-note--danger" : "scr-note scr-note--warn"}>
      {t("variants.model.banner", {
        n: String(flagged.length),
        variants: flagged.map((row) => row.variantId).join(", "),
      })}{" "}
      {t("variants.model.banner_fix")}
    </div>
  );
}

/**
 * Model sütununun bir hücresi — ve model adı SORUNLUYSA bunu söyleyen rozet.
 * Yargı `variantModelHealth` üzerinden `@maestro/db/variant-model`'e gider:
 * `auditVariantModels`'in okuduğu aynı iki fonksiyon, panel ile rapor
 * birbirinden ayrışmasın diye.
 */
export function ModelCell({ model }: { readonly model: string }): ReactNode {
  const t = useT();
  const health = variantModelHealth(model);

  if (health === "ok") return <code>{model}</code>;
  return (
    <span className="scr-row">
      <code>{model}</code>
      <Badge tone={health === "cloud" ? "red" : "amber"}>
        {health === "cloud" ? t("variants.model.cloud_badge") : t("variants.model.unset_badge")}
      </Badge>
    </span>
  );
}

function CreateVariantModal({
  onClose,
  onCreated,
}: {
  readonly onClose: () => void;
  readonly onCreated: (variantId: string) => void;
}): ReactNode {
  const api = useApi();
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const enumLabel = useEnumLabel();

  const [variantId, setVariantId] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<LlmRole>("analyst");
  /**
   * Model BOŞ başlar — gömülü bir varsayılan YOK. İnternetsiz bir kurulumda
   * gömülü bir ad hiçbir sunucuda yoktur; hata çok sonra, ilk çağrıda görünür.
   * Boş başlamak alanı zorunlu kılar: admin kendi sunucusunun servis ettiği adı
   * seçmeden formu geçemez.
   */
  const [model, setModel] = useState("");
  const modelOptions = useConnectionModels();
  const [persona, setPersona] = useState("");
  const [note, setNote] = useState(t("variants.create.first_note"));
  const [touched, setTouched] = useState(false);

  const errors = {
    id: !isValidVariantId(variantId),
    name: !isValidName(name),
    model: !isValidModel(model),
    persona: !isValidPersona(persona),
    note: !isValidNote(note),
  };
  const blocked = Object.values(errors).some(Boolean);

  const create = useMutation({
    mutationFn: () =>
      api.post<AgentVariant>("/variants", {
        variantId: variantId.trim(),
        role,
        platform: name.trim(),
        model: model.trim(),
        persona,
        note: note.trim(),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["variants"] });
      toast.show("success", t("variants.toast.created", { id: variantId.trim() }));
      onCreated(variantId.trim());
    },
    onError: (error) => toast.show("error", t(messageKeyOf(error))),
  });

  const submit = (): void => {
    setTouched(true);
    if (blocked) return;
    create.mutate();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t("variants.create.title")}
      closeLabel={t("action.close")}
      footer={
        <>
          <Button onClick={onClose}>{t("action.cancel")}</Button>
          <Button variant="primary" busy={create.isPending} onClick={submit}>
            {t("variants.action.add")}
          </Button>
        </>
      }
    >
      <div className="scr-grid scr-grid--2">
        <Input
          label={t("variants.field.name")}
          value={name}
          onChange={(event) => setName(event.target.value)}
          hint={t("variants.field.name_hint")}
          {...(touched && errors.name ? { error: t("variants.error.name") } : {})}
        />
        <Input
          label={t("variants.field.id")}
          value={variantId}
          onChange={(event) => setVariantId(event.target.value)}
          hint={t("variants.field.id_hint")}
          {...(touched && errors.id ? { error: t("variants.error.id") } : {})}
        />
        <Select
          label={t("variants.field.role")}
          value={role}
          onChange={(event) => setRole(event.target.value as LlmRole)}
          options={PINNED_ROLES.map((option) => ({
            value: option,
            label: enumLabel("llm.role", option).text,
          }))}
        />
        <ModelField
          value={model}
          onChange={setModel}
          options={modelOptions}
          hint={t("variants.field.model_hint")}
          {...(touched && errors.model ? { error: t("variants.error.model") } : {})}
        />
      </div>
      <TextArea
        label={t("variants.field.persona")}
        rows={5}
        value={persona}
        onChange={(event) => setPersona(event.target.value)}
        hint={t("variants.field.persona_hint")}
        {...(touched && errors.persona ? { error: t("variants.error.persona") } : {})}
      />
      <LoadTrainingButton role={role} onLoaded={setPersona} />
      <details className="scr-adv">
        <summary className="scr-adv__summary">{t("variants.field.note")}</summary>
        <Input
          label={t("variants.field.note")}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          {...(touched && errors.note ? { error: t("variants.error.note") } : {})}
        />
      </details>
    </Modal>
  );
}

/**
 * "Varsayılan eğitimi yükle": puts the role's shipped training (the same text
 * the installer seeded as the default agent's persona) into the persona box.
 * The operator starts from the customer's brief instead of a blank field, and
 * can restore it after an edit went wrong. Nothing is saved by this button.
 */
export function LoadTrainingButton({
  role,
  onLoaded,
}: {
  readonly role: LlmRole;
  readonly onLoaded: (persona: string) => void;
}): ReactNode {
  const t = useT();
  const api = useApi();
  const toast = useToast();
  const enumLabel = useEnumLabel();
  const load = useMutation({
    mutationFn: () => api.get<{ role: string; persona: string }>(`/variants/default-training/${encodeURIComponent(role)}`),
    onSuccess: (body) => {
      onLoaded(body.persona);
      toast.show("success", t("variants.toast.training_loaded", { role: enumLabel("llm.role", role).text }));
    },
    onError: () => toast.show("error", t("variants.toast.training_unavailable")),
  });
  return (
    <p className="scr-mini" style={{ marginTop: -6, marginBottom: 10 }}>
      <button type="button" className="scr-linkbtn scr-link" onClick={() => load.mutate()} disabled={load.isPending}>
        {t("variants.action.load_training")}
      </button>{" "}
      <span className="scr-hint">{t("variants.action.load_training_hint")}</span>
    </p>
  );
}
