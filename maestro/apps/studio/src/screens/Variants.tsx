import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router";
import { LlmRole, type LlmRole as LlmRoleType } from "@maestro/contracts";
import { messageKeyOf } from "../api/errors.ts";
import { useApi } from "../auth/AuthProvider.tsx";
import { useAuth } from "../auth/AuthProvider.tsx";
import { hasRole } from "../auth/types.ts";
import { useT } from "../i18n/I18nProvider.tsx";
import { Badge, Button, Card, Input, Modal, Select, Table, useToast } from "../ui/index.ts";
import { TextArea } from "./shared/TextArea.tsx";
import { useEnumLabel } from "./common/label.ts";
import { MaybeUnwired } from "./shared/unwired.tsx";
import { parseKnowledge } from "./variants/knowledge.ts";
import { ModelField, useConnectionModels } from "./variants/ModelField.tsx";
import { variantModelHealth } from "./variants/model-source.ts";
import "./shared/screens.css";
import "./common/screens.css";

/**
 * Screen: variants — the agent variant catalogue (7 roles × platform).
 *
 * Versions are immutable: a new version is published and can be rolled back in
 * one step, and running workflows finish on the version they started with.
 *
 * An admin creates a variant here; editing the platform and publishing a new
 * version live on the detail screen. Every write is admin-only — the persona
 * and model an agent runs under decide what the AI does on every ticket — and
 * the BFF enforces that regardless of what this UI shows.
 */

export interface AgentVariant {
  readonly variantId: string;
  readonly role: LlmRoleType;
  readonly platform: string;
  readonly model: string;
  readonly activeVersion: number;
  readonly knowledgeFiles: number;
  /** Latest golden-ticket eval score, or null when never evaluated. */
  readonly evalScore: number | null;
}

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
        <MaybeUnwired
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
                key: "variant",
                header: t("variants.col.variant"),
                cell: (row: AgentVariant) => row.variantId,
              },
              {
                key: "role",
                header: t("variants.col.role"),
                cell: (row) => enumLabel("llm.role", row.role).text,
              },
              { key: "platform", header: t("variants.col.platform"), cell: (row) => row.platform },
              {
                key: "model",
                header: t("variants.col.model"),
                cell: (row) => <ModelCell model={row.model} />,
              },
              {
                key: "version",
                header: t("variants.col.version"),
                cell: (row) => <Badge tone="blue">v{row.activeVersion}</Badge>,
              },
              {
                key: "knowledge",
                header: t("variants.col.knowledge"),
                cell: (row) => t("variants.n_files", { n: String(row.knowledgeFiles) }),
                align: "right",
              },
              {
                key: "eval",
                header: t("variants.col.eval"),
                // null is "never evaluated", which is not the same as a score of
                // zero and must not be rendered as one.
                cell: (row) =>
                  row.evalScore === null ? (
                    <Badge tone="gray">{t("variants.never_evaluated")}</Badge>
                  ) : (
                    <Badge tone={row.evalScore >= 90 ? "green" : "amber"}>{String(row.evalScore)}</Badge>
                  ),
                align: "right",
              },
            ]}
            rows={query.data?.variants ?? []}
            rowKey={(row) => row.variantId}
            onRowClick={(row) => void navigate(`/variant?id=${encodeURIComponent(row.variantId)}`)}
            emptyLabel={t("variants.empty")}
          />
        </MaybeUnwired>
      </Card>

      <p className="tpl-keyline" style={{ marginTop: 12 }}>
        {t("variants.immutable_note")}
      </p>

      {creating && (
        <CreateVariantModal
          onClose={() => setCreating(false)}
          onCreated={(variantId) => {
            setCreating(false);
            void navigate(`/variant?id=${encodeURIComponent(variantId)}`);
          }}
        />
      )}
    </>
  );
}

/**
 * Listenin üstünde duran özet: kaç ajanın modeli eksik/erişilemez ve NE
 * YAPILACAĞI.
 *
 * Rozetler tek tek satırları işaretliyor; bu satır ise "düzelt yolunu"
 * gösteriyor — rozet gören operatörün sorması gereken bir sonraki soru "peki
 * nasıl?" ve cevabın raporun ya da bir kabuk betiğinin içinde olmaması lazım.
 * Cevap kısa: satıra tıkla, "Yeni sürüm yayınla", modeli yaz (bağlantıdaki
 * model orada öneri olarak duruyor).
 *
 * Hiçbir bulgu yoksa hiçbir şey çizilmez: temiz bir kurulumda operatöre
 * okuyacak bir uyarı vermek, gerçek bir uyarının fark edilme şansını düşürür.
 */
function ModelHealthBanner({
  variants,
}: {
  readonly variants: readonly AgentVariant[];
}): ReactNode {
  const t = useT();
  const flagged = variants.filter((row) => variantModelHealth(row.model) !== "ok");
  if (flagged.length === 0) return null;

  const cloud = flagged.filter((row) => variantModelHealth(row.model) === "cloud");
  return (
    <div
      className={cloud.length > 0 ? "scr-note scr-note--danger" : "scr-note scr-note--warn"}
      style={{ margin: "12px 14px" }}
    >
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
 *
 * ── NİYE GEREKLİ ────────────────────────────────────────────────────────────
 * Sütun eskiden model adını düz `<code>` olarak yazıyordu, hepsini aynı
 * biçimde. Yani `secilmedi` yazan bir satır — hiç model seçilmemiş bir ajan —
 * kurumun kendi `qwen2.5-coder-32b-instruct` modelini taşıyan satırdan görsel
 * olarak AYIRT EDİLEMİYORDU. Aynısı `anthropic/claude-sonnet-4.5` için de
 * geçerli: internetsiz kurulumda o ajanla başlatılan her koşu ilk model
 * çağrısında ölür, ama listede sağlıklı bir satır gibi duruyordu. Sorun
 * `/studio/config-health` raporunda ve `./ajan-modelleri.sh` çıktısında
 * görünüyordu — yani operatörün ajanlara BAKTIĞI yerde değil, aramayı bilmesi
 * gereken iki başka yerde.
 *
 * Yargı `variantModelHealth` üzerinden `@maestro/db/variant-model`'e gider —
 * `auditVariantModels`'in okuduğu AYNI iki fonksiyon (`isModelSelected`,
 * `isCloudModelName`). Kural burada yeniden yazılmadı; yazılsaydı panel ile
 * rapor birbirinden ayrışabilirdi, ki bu operatöre iki farklı gerçek söylemek
 * demek olurdu.
 */
function ModelCell({ model }: { readonly model: string }): ReactNode {
  const t = useT();
  const health = variantModelHealth(model);

  if (health === "ok") return <code>{model}</code>;
  return (
    <span className="scr-row" style={{ gap: 6 }}>
      <code>{model}</code>
      <Badge tone={health === "cloud" ? "red" : "amber"}>
        {health === "cloud" ? t("variants.model.cloud_badge") : t("variants.model.unset_badge")}
      </Badge>
    </span>
  );
}

/** The roles a variant may take (M17/M43), from the frozen contract. */
const ROLE_OPTIONS = LlmRole.options;

/**
 * The roles the ENGINE actually runs today: intake (fitness gate), analyst and
 * engineer. The other four exist in the frozen contract but nothing executes
 * them yet, so the create modal lists them DISABLED with a "(yakında)" mark —
 * visible so the roadmap is honest, unselectable so an admin cannot configure
 * an agent that would never run.
 */
const LIVE_ROLES: ReadonlySet<LlmRoleType> = new Set(["intake", "analyst", "engineer"]);

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
  const [role, setRole] = useState<LlmRoleType>("analyst");
  const [platform, setPlatform] = useState("web");
  /**
   * Model alanı BOŞ başlar — gömülü bir varsayılan YOK.
   *
   * Burada eskiden `"claude-opus-5"` yazıyordu. Kurum içi, internetsiz bir
   * kurulumda o ad hiçbir sunucuda yok: admin formu açıp modeli değiştirmeden
   * kaydettiğinde, hiç dialanamayacak bir model adıyla bir ajan tanımlanmış
   * oluyordu — ve hata çok sonra, ilk çağrıda, "sağlayıcı cevap vermedi" diye
   * görünüyordu. Boş başlamak alanı ZORUNLU kılar (`modelInvalid`), yani admin
   * kendi model sunucusunun servis ettiği adı yazmadan formu geçemez.
   */
  const [model, setModel] = useState("");
  /**
   * Bağlantı panelinde tanımlı model adları — açılır listenin seçenekleri.
   * Alan boş başlamaya devam ediyor ("— model seçin —"): listenin ilk satırını
   * otomatik seçmek, yukarıdaki "gömülü varsayılan yok" kuralını arka kapıdan
   * geri getirirdi (admin hiçbir şey seçmeden formu geçebilirdi). Fark şu ki
   * artık model adını hatırlamak — hatta yazmak — gerekmiyor.
   */
  const modelOptions = useConnectionModels();
  const [persona, setPersona] = useState("");
  const [knowledge, setKnowledge] = useState("");
  const [note, setNote] = useState(t("variants.create.first_note"));
  const [touched, setTouched] = useState(false);

  const idInvalid = !/^[a-z0-9][a-z0-9-]*$/.test(variantId.trim());
  const platformInvalid = platform.trim() === "";
  const modelInvalid = model.trim() === "";
  const blocked = idInvalid || platformInvalid || modelInvalid;

  const create = useMutation({
    mutationFn: () =>
      api.post<AgentVariant>("/variants", {
        variantId: variantId.trim(),
        role,
        platform: platform.trim(),
        model: model.trim(),
        persona,
        knowledgeRefs: parseKnowledge(knowledge),
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
      <Input
        label={t("variants.field.id")}
        value={variantId}
        onChange={(event) => setVariantId(event.target.value)}
        hint={t("variants.field.id_hint")}
        {...(touched && idInvalid ? { error: t("variants.error.id") } : {})}
      />
      <Select
        label={t("variants.field.role")}
        value={role}
        onChange={(event) => setRole(event.target.value as LlmRoleType)}
        options={ROLE_OPTIONS.map((option) => {
          const live = LIVE_ROLES.has(option);
          const text = enumLabel("llm.role", option).text;
          return {
            value: option,
            label: live ? text : t("variants.role.soon", { role: text }),
            disabled: !live,
          };
        })}
      />
      <Input
        label={t("variants.field.platform")}
        value={platform}
        onChange={(event) => setPlatform(event.target.value)}
        hint={t("variants.field.platform_hint")}
        {...(touched && platformInvalid ? { error: t("variants.error.platform") } : {})}
      />
      <ModelField
        value={model}
        onChange={setModel}
        options={modelOptions}
        hint={t("variants.field.model_hint")}
        {...(touched && modelInvalid ? { error: t("variants.error.model") } : {})}
      />
      <TextArea
        label={t("variants.field.persona")}
        rows={8}
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
      />
    </Modal>
  );
}
