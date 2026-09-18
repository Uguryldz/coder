import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router";
import { messageKeyOf } from "../api/errors.ts";
import { useApi, useAuth } from "../auth/AuthProvider.tsx";
import { hasAnyRole, hasRole } from "../auth/types.ts";
import { useT } from "../i18n/I18nProvider.tsx";
import { Badge, Button, Card, Modal, Select, Table, useToast } from "../ui/index.ts";
import type {
  ApplicationRecord,
  DataClassPolicy,
  Page,
  ParamPutResult,
  PendingBinding,
  RoutingBindingSettings,
  RoutingUpdate,
  RoutingView,
} from "./common/index.ts";
import { useEnumLabel, usePhrase } from "./common/label.ts";
import { outcomeExplanationKey, outcomeKey, outcomeTone } from "./shared/outcome.ts";
import { RoutingPolicyEditor } from "./routing/RoutingPolicyEditor.tsx";
import { QueryState } from "./shared/QueryState.tsx";

/**
 * Screen: routing — the bound projects, the onboarding approval queue, and
 * (collapsed) the LLM routing policy and the application registry.
 *
 * The approval queue is the four-eyes step: a submitted binding waits here
 * for a second admin or tech-lead — or for the principal approver, who may
 * confirm alone when the install has one admin. Approving turns a proposal into
 * a live binding; the screen then sends the approver straight to the
 * listening rules of the project that just went live, because a bound project
 * with no rule accepts no ticket.
 *
 * "Düzenle" on a bound project opens `BindingEdit`, a panel rather than a
 * form, because most of what an operator wants to change there HAS no
 * endpoint: `POST /onboarding` is a CREATE path that refuses an already-bound
 * project, and no update endpoint exists. The panel routes to the one editable
 * thing per project — its listening rules — and names, field by field, what
 * is locked and why. It never files anything: opening it is not a change.
 */

/** Mirrors the BFF's `ONBOARDING_ROLES` (approve / reject) and `SETTINGS_WRITE_ROLES` (policy). */
const APPROVE_ROLES = ["admin", "tech-lead"] as const;

/**
 * The named reasons `POST /onboarding/approve` can give for a seed that did
 * not run, each mapped to its short phrase. An unknown reason — a BFF newer
 * than this screen — falls back to the generic one rather than crashing `t()`.
 */
const SEED_SKIP_REASON_KEYS: Readonly<Record<string, string>> = {
  issue_types_unavailable: "listening.seedskip.issue_types_unavailable",
  no_jira_connection: "listening.seedskip.no_jira_connection",
  bot_account_unknown: "listening.seedskip.bot_account_unknown",
  listening_unwired: "listening.seedskip.listening_unwired",
  connections_unwired: "listening.seedskip.connections_unwired",
  seed_error: "listening.seedskip.seed_error",
};

function seedSkipReasonKey(reason: string): string {
  return SEED_SKIP_REASON_KEYS[reason] ?? "listening.seedskip.seed_error";
}

/** The listening tab for a project — where a freshly bound project's next step lives. */
function listeningPath(projectKey: string): string {
  return `/projects?tab=listening&projectKey=${encodeURIComponent(projectKey)}`;
}

export function RoutingScreen(): ReactNode {
  const t = useT();
  const api = useApi();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const phrase = usePhrase();
  const enumLabel = useEnumLabel();
  const navigate = useNavigate();

  const [editing, setEditing] = useState(false);
  const [pendingBy, setPendingBy] = useState<string | null>(null);
  // Which bound project's "Düzenle" is open, or null. See `BindingEdit`.
  const [editingBinding, setEditingBinding] = useState<string | null>(null);

  const routing = useQuery({
    queryKey: ["routing"],
    queryFn: ({ signal }) => api.get<RoutingView>("/routing", { signal }),
  });

  // The Application Registry (M100): the TARGETS a match resolves to.
  const apps = useQuery({
    queryKey: ["studio-apps"],
    queryFn: ({ signal }) => api.get<Page<ApplicationRecord>>("/studio/apps", { signal }),
  });

  // Which projects have at least one listening rule. A bound project with NO
  // rule accepts no ticket — it looks "live" but does nothing.
  const listeningRules = useQuery({
    queryKey: ["listening-rules"],
    queryFn: ({ signal }) =>
      api.get<{
        rules: readonly {
          projectKey: string;
          flowType: string;
          matchKind: string;
          matchValue: string;
          enabled: boolean;
          repoMap?: { entries?: readonly { appId: string }[] } | null;
        }[];
      }>("/studio/listening-rules", { signal }),
  });
  const allRules = listeningRules.data?.rules ?? [];
  /**
   * PROJEYE GÖRE KURALLAR — "yeşil" tek şeyi ölçüyordu.
   *
   * Rozet yalnızca "bu projenin bir kuralı var mı" diye soruyordu. Yanlış veri
   * sınıfıyla, erişilemeyen bir depoyla ve hiçbir ticket'ın taşımadığı bir
   * eşleşme değeriyle bağlanmış bir proje de YEŞİL görünüyordu.
   *
   * Liste bunu açıyor: her projenin altında kuralları, ne yaptıkları ve hangi
   * depoya indikleriyle. Operatörün "bağlı ama çalışmıyor" dediği durumun
   * cevabı burada görünür oluyor.
   */
  const rulesByProject = new Map<string, typeof allRules>();
  for (const rule of allRules) {
    rulesByProject.set(rule.projectKey, [...(rulesByProject.get(rule.projectKey) ?? []), rule]);
  }

  // Two different gates on the BFF: the approval queue is admin + tech-lead
  // (the four-eyes second person is often the tech lead), the guarded policy
  // parameter is admin only. One flag for both used to hide the queue from
  // the tech lead and block the four-eyes flow at the UI.
  const canApprove = hasAnyRole(session, APPROVE_ROLES);
  const canEditPolicy = hasRole(session, "admin");
  // The binding panel is for whoever may change what it points at — admin.
  const canEditBinding = hasRole(session, "admin");

  /**
   * The current policy, taken VERBATIM from the server — never reconstructed
   * from the rendered rules, whose outcome is lossy (`degrade_ai_assist` and
   * `masked_cloud` both read as `degraded`).
   */
  const currentPolicy: DataClassPolicy | null = routing.data?.policy ?? null;

  const save = useMutation({
    mutationFn: (policy: DataClassPolicy) => api.put<ParamPutResult>("/routing", { policy } satisfies RoutingUpdate),
    onSuccess: (result) => {
      setEditing(false);
      if (result.status === "applied") {
        setPendingBy(null);
        void queryClient.invalidateQueries({ queryKey: ["routing"] });
        toast.show("success", t("routing.policy.toast.applied"));
      } else {
        setPendingBy(result.pending.proposedBy);
        toast.show("warning", t("routing.policy.toast.pending"));
      }
    },
    onError: (error) => toast.show("error", t(messageKeyOf(error))),
  });

  // Onboarding packages awaiting a second approver (M93).
  const pending = useQuery({
    queryKey: ["onboarding-pending"],
    queryFn: ({ signal }) => api.get<{ items: readonly PendingBinding[] }>("/onboarding/pending", { signal }),
    enabled: canApprove,
  });

  const approve = useMutation({
    mutationFn: (projectKey: string) =>
      api.post<{
        status: string;
        projectKey: string;
        nextStep: string;
        /** Ready-made rules auto-seeded on approval; null when nothing ran. */
        listeningSeed?: { created: number; skipped: number } | null;
        /** WHY nothing ran, when `listeningSeed` is null — never absent silently. */
        seedSkipped?: { reason: string } | null;
      }>("/onboarding/approve", { projectKey }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["onboarding-pending"] });
      void queryClient.invalidateQueries({ queryKey: ["routing"] });
      void queryClient.invalidateQueries({ queryKey: ["listening-rules"] });
      const seeded = result.listeningSeed;
      if (seeded != null && seeded.created > 0) {
        toast.show(
          "success",
          t("routing.pending.toast.bound_seeded", { project: result.projectKey, n: String(seeded.created) }),
        );
      } else if (result.seedSkipped != null) {
        // Bound, but the default rules could NOT be seeded: a warning that
        // names the reason, instead of a green half-truth.
        toast.show(
          "warning",
          t("routing.pending.toast.bound_seed_skipped", {
            project: result.projectKey,
            reason: t(seedSkipReasonKey(result.seedSkipped.reason)),
          }),
        );
      } else {
        toast.show("success", t("routing.pending.toast.bound", { project: result.projectKey }));
      }
      // The chain's next step, taken rather than offered: the "add a rule"
      // prompt used to live inside the queue card, which disappears with the
      // last approved package — the operator was pointed at a button that had
      // just vanished.
      void navigate(listeningPath(result.projectKey));
    },
    onError: (error) => toast.show("error", t(messageKeyOf(error))),
  });

  const reject = useMutation({
    mutationFn: (projectKey: string) => api.post("/onboarding/reject", { projectKey }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["onboarding-pending"] });
      toast.show("success", t("routing.pending.toast.rejected"));
    },
    onError: (error) => toast.show("error", t(messageKeyOf(error))),
  });

  return (
    <div className="scr-stack">
      {/* The approval queue — only when there is something to approve. */}
      {canApprove && (pending.data?.items.length ?? 0) > 0 && (
        <Card title={t("routing.pending.title")} subtitle={t("routing.pending.sub")} padded={false}>
          <Table
            columns={[
              { key: "project", header: t("routing.col.project"), cell: (row: PendingBinding) => <b>{row.projectKey}</b> },
              {
                key: "repo",
                header: t("routing.pending.col.repo"),
                // A package binds no repository any more — the repo comes from
                // the listening rule's repo map — so an empty cell says THAT in
                // words rather than reading as data loss. A legacy package that
                // still carries one shows it.
                cell: (row: PendingBinding) =>
                  row.adoRepo === null ? (
                    <span className="scr-mini">{t("routing.pending.norepo")}</span>
                  ) : (
                    <>
                      <span className="scr-mono">{row.adoRepo}</span>
                      {row.platform !== null && (
                        <span className="scr-mini"> · {enumLabel("platform", row.platform).text}</span>
                      )}
                    </>
                  ),
              },
              {
                key: "settings",
                header: t("routing.pending.col.settings"),
                // What approval WRITES — gates, merge, data class — in front of
                // the second human. The data class in particular decides whether
                // the project's tickets may reach a cloud model.
                cell: (row: PendingBinding) => (
                  <span className="scr-mini">
                    {t(`onboard.gate_set.${row.gateSet}`)} · {t(`onboard.merge.${row.mergeMode}`)} ·{" "}
                    {/* A proposal filed before the data class was carried on the
                        pending row has none to show; an unknown class must not be
                        turned into a catalog key. */}
                    {row.dataClass === undefined ? "—" : t(`routing.data_class.${row.dataClass}`)}
                  </span>
                ),
              },
              {
                key: "by",
                header: t("routing.pending.col.by"),
                cell: (row: PendingBinding) => <span className="scr-mini">{row.proposedBy}</span>,
              },
              {
                key: "act",
                header: "",
                cell: (row: PendingBinding) => (
                  <div className="scr-row">
                    <Button size="sm" variant="success" busy={approve.isPending} onClick={() => approve.mutate(row.projectKey)}>
                      {t("routing.pending.approve")}
                    </Button>
                    <Button size="sm" busy={reject.isPending} onClick={() => reject.mutate(row.projectKey)}>
                      {t("routing.pending.reject")}
                    </Button>
                  </div>
                ),
              },
            ]}
            rows={pending.data?.items ?? []}
            rowKey={(row) => row.projectKey}
            emptyLabel={t("routing.pending.empty")}
          />
        </Card>
      )}

      <Card
        title={t("routing.projects")}
        subtitle={t("routing.projects_sub")}
        padded={false}
        actions={
          <Button size="sm" onClick={() => void navigate("/setup")}>
            {t("routing.action.bind")}
          </Button>
        }
      >
        <QueryState
          isPending={routing.isPending}
          error={routing.error}
          isEmpty={(routing.data?.projects ?? []).length === 0}
          emptyTitle={t("routing.no_projects")}
          onRetry={() => void routing.refetch()}
        >
          <Table
            columns={[
              { key: "project", header: t("routing.col.project"), cell: (row) => row.projectKey },
              {
                key: "apps",
                header: t("routing.col.apps"),
                cell: (row) => (row.apps.length === 0 ? t("routing.no_apps") : row.apps.join(", ")),
              },
              { key: "note", header: t("routing.col.note"), cell: (row) => phrase(row.noteKey, row.noteParams) },
              {
                key: "edit",
                header: "",
                // Admin only. It opens a panel rather than a form — see
                // `BindingEdit`: a save button here would file nothing.
                cell: (row) =>
                  /*
                    "Depo ekle" BURADAN KALKTI.
                    Depo artık tek bir yerden gelir: dinleme kuralının depo
                    eşlemesi. İki ekranda uygulama seçtirmek, aynı soruyu iki
                    kez sormaktı — ve ikisi ayrışınca hangisinin kazandığı
                    ekranda hiçbir yerde yazmıyordu.
                  */
                  canEditBinding ? (
                    <div className="scr-actions" style={{ margin: 0 }}>
                      <Button size="sm" onClick={() => setEditingBinding(row.projectKey)}>
                        {t("routing.action.edit_binding")}
                      </Button>
                    </div>
                  ) : null,
              },
              {
                key: "status",
                header: t("routing.col.status"),
                // A bound project with no listening rule accepts no ticket: say
                // so and link to the step that fixes it. A working one links to
                // its rules too — that is the one editable thing per project.
                cell: (row) => {
                  /*
                   * KURALLAR ADLARIYLA — "yeşil" tek şeyi ölçüyordu.
                   *
                   * Rozet yalnızca "bir kuralı var mı" diyordu; yanlış veri
                   * sınıfıyla, erişilemeyen bir depoyla ya da hiçbir ticket'ın
                   * taşımadığı bir eşleşme değeriyle bağlanmış bir proje de
                   * YEŞİL görünüyordu. Kurallar burada, ne yaptıkları ve hangi
                   * depoya indikleriyle listeleniyor.
                   */
                  const rules = rulesByProject.get(row.projectKey) ?? [];
                  return (
                    <div>
                      <Button
                        variant="link"
                        size="sm"
                        onClick={() => void navigate(listeningPath(row.projectKey))}
                      >
                        {rules.length > 0 ? (
                          <Badge tone="green">
                            {t("routing.status.rule_count", { count: String(rules.length) })}
                          </Badge>
                        ) : (
                          <Badge tone="amber">{t("routing.status.no_rule")}</Badge>
                        )}
                      </Button>
                      {rules.map((rule) => {
                        const repo = rule.repoMap?.entries?.[0]?.appId ?? null;
                        return (
                          <p key={`${rule.matchKind}:${rule.matchValue}`} className="scr-hint">
                            {t(`listening.flow.${rule.flowType}`)} ·{" "}
                            {t(`listening.match.${rule.matchKind}`)}
                            {rule.matchKind === "assigned" ? "" : ` = ${rule.matchValue}`}
                            {repo === null ? "" : ` → ${repo}`}
                            {rule.enabled ? "" : ` · ${t("listening.rule.disabled")}`}
                          </p>
                        );
                      })}
                    </div>
                  );
                },
              },
            ]}
            rows={routing.data?.projects ?? []}
            rowKey={(row) => row.projectKey}
            emptyLabel={t("routing.no_projects")}
          />
        </QueryState>
      </Card>

      {/* Reference / infrastructure, collapsed: the model policy and the app
          inventory are not the operator's task on this page. */}
      <details className="scr-adv">
        <summary className="scr-adv__summary">{t("routing.advanced.summary")}</summary>
        <div className="scr-stack scr-mt-2">
          <p className="scr-mini">{t("routing.advanced.how_it_works")}</p>

          <Card
            title={t("routing.policy")}
            subtitle={t("routing.policy_sub")}
            padded={false}
            actions={
              canEditPolicy ? (
                <Button size="sm" variant="primary" disabled={currentPolicy === null} onClick={() => setEditing(true)}>
                  {t("routing.policy.action.edit")}
                </Button>
              ) : undefined
            }
          >
            <QueryState
              isPending={routing.isPending}
              error={routing.error}
              isEmpty={(routing.data?.rules ?? []).length === 0}
              emptyTitle={t("routing.no_rules")}
            >
              <Table
                columns={[
                  { key: "condition", header: t("routing.col.condition"), cell: (row) => phrase(row.conditionKey, row.conditionParams) },
                  { key: "backend", header: t("routing.col.backend"), cell: (row) => <Badge tone="gray">{row.backend}</Badge> },
                  { key: "model", header: t("routing.col.model"), cell: (row) => <code>{row.model}</code> },
                  {
                    key: "outcome",
                    header: t("routing.col.outcome"),
                    cell: (row) => <Badge tone={outcomeTone(row.outcome)}>{t(outcomeKey(row.outcome))}</Badge>,
                  },
                  { key: "meaning", header: t("routing.col.meaning"), cell: (row) => t(outcomeExplanationKey(row.outcome)) },
                ]}
                rows={routing.data?.rules ?? []}
                rowKey={(row) => row.ruleId}
                emptyLabel={t("routing.no_rules")}
              />
            </QueryState>
          </Card>

          <Card title={t("routing.registry")} subtitle={t("routing.registry_sub")} padded={false}>
            <QueryState
              isPending={apps.isPending}
              error={apps.error}
              isEmpty={(apps.data?.items ?? []).length === 0}
              emptyTitle={t("routing.registry_empty")}
              onRetry={() => void apps.refetch()}
            >
              <Table
                columns={[
                  { key: "app", header: t("routing.registry.col.app"), cell: (row) => <b>{row.displayName}</b> },
                  {
                    /*
                      HANGİ PROJEYE AİT — sahipliğin GERÇEK alanı.
                      `/routing`in proje→uygulama listesi tam olarak bu kolona
                      dayanıyor (`stores/routing.ts`) ama ekran onu hiç
                      göstermiyordu. Canlıda ölçüldü: bir deponun değeri NULL
                      (sahipsiz) iken, bağlamanın varsayılanı o olduğu için
                      listede o projenin altında görünüyordu. Operatör deponun
                      bağlı olduğunu sanıyordu — "proje bağlama tutarsız"
                      şikayetinin kaynağı buydu. Artık sahipsizlik yazıyor.
                    */
                    key: "owner",
                    header: t("routing.registry.col.owner"),
                    cell: (row) =>
                      row.jiraProjectKey === null ? (
                        <span className="scr-hint scr-hint--warn" style={{ display: "inline", margin: 0, padding: "2px 6px" }}>
                          {t("routing.registry.unowned")}
                        </span>
                      ) : (
                        <code className="scr-mono">{row.jiraProjectKey}</code>
                      ),
                  },
                  {
                    key: "repo",
                    header: t("routing.registry.col.repo"),
                    cell: (row) => <code className="scr-mono">{`${row.adoProject}/_git/${row.adoRepo}`}</code>,
                  },
                  {
                    key: "platform",
                    header: t("routing.registry.col.platform"),
                    // The readable profile name, never the raw slug.
                    cell: (row) => <Badge tone="gray">{enumLabel("platform", row.platform).text}</Badge>,
                  },
                  {
                    key: "yaml",
                    header: t("routing.registry.col.yaml"),
                    cell: (row) =>
                      row.maestroYamlPresent ? (
                        <Badge tone="green">{t("routing.registry.yaml_present")}</Badge>
                      ) : (
                        <Badge tone="amber">{t("routing.registry.yaml_absent")}</Badge>
                      ),
                  },
                  { key: "source", header: t("routing.registry.col.source"), cell: (row) => t(`routing.registry.source.${row.createdVia}`) },
                ]}
                rows={apps.data?.items ?? []}
                rowKey={(row) => row.appId}
                emptyLabel={t("routing.registry_empty")}
              />
            </QueryState>
            <p className="scr-mini routing-foot">{t("routing.registry_note")}</p>
          </Card>

          <p className="scr-keyline">{t("routing.config_note")}</p>
        </div>
      </details>

      {editingBinding !== null && (
        <BindingEdit
          projectKey={editingBinding}
          current={routing.data?.projects.find((p) => p.projectKey === editingBinding)?.binding ?? null}
          onClose={() => setEditingBinding(null)}
          onOpenRules={(key) => void navigate(listeningPath(key))}
          onSaved={() => {
            void queryClient.invalidateQueries({ queryKey: ["routing"] });
            setEditingBinding(null);
          }}
        />
      )}

      {currentPolicy !== null && (
        <RoutingPolicyEditor
          open={editing}
          current={currentPolicy}
          pendingBy={pendingBy}
          busy={save.isPending}
          onClose={() => setEditing(false)}
          onSubmit={(policy) => save.mutate(policy)}
        />
      )}
    </div>
  );
}

/**
 * "Düzenle" on a bound project — ARTIK GERÇEK BİR FORM.
 *
 * Burası bir dönem form DEĞİLDİ ve gerekçesi yazılıydı: `POST /onboarding`
 * zaten bağlı bir projeyi reddediyor, güncelleme ucu ise YOKTU. O hâlde bir
 * "Kaydet" düğmesi hiçbir şey dosyalamayıp başarı bildirirdi — bir ajanın
 * hangi depoya yazabileceğine dair dört-göz kararında mümkün olan en kötü
 * yalan. Panel bu yüzden yalnız "dinleme kurallarına git" diyordu.
 *
 * Sahada bu "UI'da yetersiz" diye bildirildi ve haklıydı: tetikleme kipi,
 * yayınlama kipi, veri sınıfı ve varsayılan uygulama bir kez yazıldıktan
 * sonra değiştirilemiyordu; tek çare projeyi çözüp yeniden onboard etmek ve
 * İKİNCİ bir onaydan geçmekti.
 *
 * `PATCH /onboarding/:projectKey` eklendi (bkz. `routes/onboarding.ts`) ve
 * panel artık ona yazıyor. Yalnız DEĞİŞEN alanlar gönderiliyor: yokluk
 * "dokunma" demek, ve tek bir alanı düzeltmek için ötekileri yeniden
 * göndermek, eş zamanlı bir düzenlemeyi sessizce geri alırdı.
 */
function BindingEdit({
  projectKey,
  current,
  onClose,
  onOpenRules,
  onSaved,
}: {
  readonly projectKey: string;
  /**
   * The binding's settings TODAY, from `/routing` (`RoutingProject.binding`).
   * `null` on a BFF that does not send them — the boxes then open on
   * "leave unchanged" instead of a value nobody read.
   */
  readonly current: RoutingBindingSettings | null;
  readonly onClose: () => void;
  readonly onOpenRules: (projectKey: string) => void;
  readonly onSaved: () => void;
}): ReactNode {
  const t = useT();
  const api = useApi();
  const toast = useToast();
  const enumLabel = useEnumLabel();
  /**
   * KUTULAR MEVCUT DEĞERLE AÇILIR — `/routing` artık gönderiyor.
   *
   * Bir dönem her kutu "— değiştirme —" ile açılıyordu, çünkü `/routing`
   * bağlamanın tetikleme kipini, yayınlama kipini, veri sınıfını ve durumunu
   * GÖNDERMİYORDU; uydurma bir varsayılan operatöre "şu anda böyle" diye
   * yanlış bilgi verir, dokunulmayan kutu kaydederken gerçek değeri ezerdi.
   * Sahada bu "düzenleme boş form açıyor" diye bildirildi: operatör neyi neye
   * çevirdiğini göremiyordu.
   *
   * Şimdi `RoutingProject.binding` mevcut değerleri taşıyor ve kutular onunla
   * dolu. İki ilke KORUNUYOR: (1) yalnız MEVCUTTAN FARKLI alanlar gönderilir —
   * dokunulmayan kutu tele çıkmaz, eş zamanlı bir düzenleme ezilmez; (2)
   * sunucu alanı göndermiyorsa (eski BFF, `current === null`) eski davranış:
   * boş = "değiştirme". Bilinmeyen bir mevcut değer (`null` mode/dataClass)
   * da boş açılır; uydurma varsayılan yok.
   */
  const [trigger, setTrigger] = useState<string>(current?.trigger ?? "");
  const [mode, setMode] = useState<string>(current?.mode ?? "");
  const [dataClass, setDataClass] = useState<string>(current?.dataClass ?? "");
  const [state, setState] = useState<string>(current?.state ?? "");
  /** A box is sent only when it holds something AND that differs from today. */
  const changed = (value: string, today: string | null | undefined): boolean =>
    value !== "" && value !== (today ?? "");
  /** "— değiştirme —" is offered only when the current value is unknown. */
  const keepRow = (today: string | null | undefined): { value: string; label: string }[] =>
    today === null || today === undefined ? [{ value: "", label: t("routing.edit.keep") }] : [];
  /**
   * A stored value outside the panel's short list (`ai_assist`, `human_only`)
   * is still shown by its own name, so opening the panel never blanks it and
   * saving never silently moves it.
   */
  const extraRow = (today: string | null | undefined, known: readonly string[], prefix: string) =>
    today !== null && today !== undefined && today !== "" && !known.includes(today)
      ? [{ value: today, label: enumLabel(prefix, today).text }]
      : [];

  const save = useMutation({
    mutationFn: () => {
      /**
       * Yalnız DEĞİŞENLER gönderilir.
       *
       * Hepsini göndermek kolay olurdu ama yanlış: bu ekran açıkken başka bir
       * yönetici `dataClass`ı sıkılaştırmışsa, buradan gelen tam gövde onu
       * sessizce geri alırdı. Sunucu da yokluğu "dokunma" diye okuyor.
       */
      const defaults: Record<string, string> = {};
      if (changed(mode, current?.mode)) defaults["mode"] = mode;
      if (changed(dataClass, current?.dataClass)) defaults["dataClass"] = dataClass;
      return api.patch<void>(`/onboarding/${encodeURIComponent(projectKey)}`, {
        ...(changed(trigger, current?.trigger) ? { trigger } : {}),
        ...(changed(state, current?.state) ? { state } : {}),
        ...(Object.keys(defaults).length === 0 ? {} : { defaults }),
      });
    },
    onSuccess: () => {
      toast.show("success", t("routing.edit.saved", { project: projectKey }));
      onSaved();
    },
    onError: (error) => toast.show("error", t(messageKeyOf(error))),
  });

  return (
    <Modal
      open
      onClose={onClose}
      title={t("routing.edit.title", { project: projectKey })}
      closeLabel={t("action.close")}
      footer={
        <>
          <Button onClick={onClose}>{t("routing.edit.close")}</Button>
          <Button onClick={() => onOpenRules(projectKey)}>{t("routing.edit.open_rules")}</Button>
          <Button variant="primary" busy={save.isPending} onClick={() => save.mutate()}>
            {t("action.save")}
          </Button>
        </>
      }
    >
      <p className="scr-prose">{t("routing.edit.rules_body")}</p>
      {current !== null && <p className="scr-hint">{t("routing.edit.prefilled")}</p>}
      <div className="scr-grid scr-grid--2" style={{ marginTop: 12 }}>
        <Select
          label={t("routing.edit.trigger")}
          value={trigger}
          onChange={(e) => setTrigger(e.target.value)}
          hint={t("routing.edit.trigger_hint")}
          options={[
            ...keepRow(current?.trigger),
            { value: "auto", label: t("routing.edit.trigger.auto") },
            { value: "label", label: t("routing.edit.trigger.label") },
            { value: "command", label: t("routing.edit.trigger.command") },
          ]}
        />
        <Select
          label={t("onboard.field.merge_mode")}
          value={mode}
          onChange={(e) => setMode(e.target.value)}
          hint={t("onboard.field.merge_hint")}
          options={[
            ...keepRow(current?.mode),
            { value: "human_lead", label: t("onboard.merge.human") },
            { value: "full_auto", label: t("onboard.merge.auto") },
            ...extraRow(current?.mode, ["human_lead", "full_auto"], "mode"),
          ]}
        />
        <Select
          label={t("routing.edit.data_class")}
          value={dataClass}
          onChange={(e) => setDataClass(e.target.value)}
          hint={t("routing.edit.data_class_hint")}
          options={[
            ...keepRow(current?.dataClass),
            { value: "acik", label: t("routing.data_class.acik") },
            { value: "dahili", label: t("routing.data_class.dahili") },
            { value: "gizli", label: t("routing.data_class.gizli") },
          ]}
        />
        <Select
          label={t("routing.edit.state")}
          value={state}
          onChange={(e) => setState(e.target.value)}
          hint={t("routing.edit.state_hint")}
          options={[
            ...keepRow(current?.state),
            { value: "active", label: t("routing.edit.state.active") },
            { value: "paused", label: t("routing.edit.state.paused") },
            ...extraRow(current?.state, ["active", "paused"], "routing.edit.state"),
          ]}
        />
      </div>
    </Modal>
  );
}
