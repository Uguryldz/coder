import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { messageKeyOf } from "../api/errors.ts";
import { useApi, useAuth } from "../auth/AuthProvider.tsx";
import { hasAnyRole } from "../auth/types.ts";
import { useT } from "../i18n/I18nProvider.tsx";
import { Button, Card, useToast } from "../ui/index.ts";
import type { RoutingView } from "./common/index.ts";
import {
  bodyFromDraft,
  draftFromRule,
  draftIncomplete,
  emptyDraft,
  priorityOf,
  probeDraftOf,
  type RuleDraft,
} from "./listening/draft.ts";
import { RuleForm } from "./listening/RuleForm.tsx";
import { RuleTable } from "./listening/RuleTable.tsx";
import { SweepBanner } from "./listening/SweepBanner.tsx";
import {
  DC_INTERNAL_KEY,
  sameDraft,
  type JiraConnectionOption,
  type ListeningRule,
  type ProbeDraft,
  type ProbeResult,
  type RuleBody,
  type SweepRunResult,
  type SweepStatus,
  type VariantOption,
  type JiraFieldOption,
} from "./listening/types.ts";
import { QueryState } from "./shared/QueryState.tsx";
import { invalidateRun } from "./shared/runs.ts";

/**
 * Screen: listening — "dinleme kuralları".
 *
 * "X projesinde, bota atanmış ve <statü|iş tipi>si <değer> olan ticket
 * <analiz|düzeltme|geliştirme> olarak koşsun" satırları. Gerçek DB tablosuna
 * (`/studio/listening-rules`) yazar; Temporal hattı keşfi o tablodan okur,
 * dolayısıyla kaydedilen kural canlı kuraldır.
 *
 * Bu dosya yalnız ORKESTRA: sorgular, mutation'lar, taslak durumu, yerleşim.
 * Parçalar `listening/` altında — `RuleForm` (form), `RuleTable` (liste +
 * silme onayı), `RuleProbe` (kuralı test et), `SweepBanner` (tarama bandı),
 * `draft.ts` (taslak ↔ tel çevirisi), `types.ts` (tel tipleri).
 *
 * ROLLER BFF'İ AYNALAR: kural yazma `admin`; hazır kural yükleme
 * `admin`+`tech-lead` (SEED_ROLES — onboarding yüzeyi gibi kapılı); okuma
 * `admin`+`tech-lead`. Gerçek kapı BFF'te; burası yalnız düğmeyi gizler.
 */
const WRITE_ROLES = ["admin"] as const;
const SEED_ROLES = ["admin", "tech-lead"] as const;

export function ListeningScreen(): ReactNode {
  const t = useT();
  const api = useApi();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const canWrite = hasAnyRole(session, WRITE_ROLES);
  const canSeed = hasAnyRole(session, SEED_ROLES);

  const query = useQuery({
    queryKey: ["listening-rules"],
    queryFn: ({ signal }) =>
      api.get<{ rules: readonly ListeningRule[] }>("/studio/listening-rules", { signal }),
    retry: false,
  });

  // Bir şey ticket ARIYOR mu? Aralıklı tazelenir ki "son tur" satırı ekran
  // açıldığındaki hâlinde donmasın.
  const sweep = useQuery({
    queryKey: ["listening-status"],
    queryFn: ({ signal }) => api.get<SweepStatus>("/studio/listening-status", { signal }),
    refetchInterval: 30_000,
    retry: false,
  });

  // "Şimdi tara" — aralığı beklemeden bir tur.
  const sweepNow = useMutation({
    mutationFn: () => api.post<SweepRunResult>("/studio/listening-sweep", {}),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["listening-status"] });
      if (result.started.length > 0) invalidateRun(queryClient);
    },
  });

  const routing = useQuery({
    queryKey: ["routing"],
    queryFn: ({ signal }) => api.get<RoutingView>("/routing", { signal }),
  });
  const boundProjects = routing.data?.projects?.map((p) => p.projectKey) ?? [];
  // Bağlı proje yokken dinleme ÇALIŞMAZ: kural yazılsa bile hiçbir Jira
  // projesi taranmaz. Bunu bir ipucu satırında değil, formun yerinde söyle —
  // operatör kural yazıp "neden tetiklenmiyor" diye aramasın.
  const unbound = routing.isSuccess && boundProjects.length === 0;

  // Etkin Jira bağlantıları: bot hesabı (bağlantı testinde öğrenilir) ve
  // değer listelerinin okunacağı bağlantı buradan.
  const jiraConns = useQuery({
    queryKey: ["onboarding-jira-connections"],
    queryFn: ({ signal }) =>
      api.get<{ connections: readonly JiraConnectionOption[] }>("/onboarding/jira-connections", {
        signal,
      }),
  });
  const connections = jiraConns.data?.connections ?? [];
  const botAccountId = connections.find((c) => c.botAccountId)?.botAccountId ?? null;

  const variants = useQuery({
    queryKey: ["variants"],
    queryFn: ({ signal }) =>
      api.get<{ variants: readonly VariantOption[] }>("/variants", { signal }),
    retry: false,
  });
  const analystOptions = (variants.data?.variants ?? []).filter((v) => v.role === "analyst");
  const engineerOptions = (variants.data?.variants ?? []).filter((v) => v.role === "engineer");

  // ── Taslak ────────────────────────────────────────────────────────────────
  // `?projectKey=` ile gelen operatör (onboarding onayından) o projede açılır.
  const [searchParams] = useSearchParams();
  const [draft, setDraft] = useState<RuleDraft>(() =>
    emptyDraft(searchParams.get("projectKey") ?? ""),
  );
  const patch = (changes: Partial<RuleDraft>): void =>
    setDraft((prev) => ({ ...prev, ...changes }));
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const formRef = useRef<HTMLDivElement | null>(null);

  // Bot kimliği öğrenilince alan dolar; operatörün elle yazdığı asla ezilmez.
  useEffect(() => {
    if (!draft.assigneeTouched && draft.assigneeAccountId === "" && botAccountId) {
      patch({ assigneeAccountId: botAccountId });
    }
  }, [botAccountId, draft.assigneeTouched, draft.assigneeAccountId]);

  /**
   * HANGİ JIRA BAĞLANTISI — kuralın kendi bot hesabına göre.
   *
   * Kural bağlantı taşımaz, bot hesabı taşır; ve bir bağlantı tam olarak o
   * hesabı bilir. Listedeki ilkini almak iki Jira bağlantısında yanlış
   * projenin statülerini getiriyordu. Sıra: operatörün seçimi → bot hesabına
   * göre eşleşen → tek bağlantı → ilk bağlantı.
   */
  const jiraConnId =
    (draft.jiraConnectionId !== "" && connections.some((c) => c.id === draft.jiraConnectionId)
      ? draft.jiraConnectionId
      : null) ??
    connections.find(
      (c) => c.botAccountId !== null && c.botAccountId.trim() === draft.assigneeAccountId.trim(),
    )?.id ??
    connections[0]?.id ??
    null;

  const matchValuesUrl = (kind: string): string =>
    `/onboarding/jira-match-values?connectionId=${encodeURIComponent(jiraConnId ?? "")}` +
    `&project=${encodeURIComponent(draft.projectKey.trim())}&kind=${kind}`;

  // Seçilen projenin gerçek statü / iş tipi adları, canlı Jira'dan. Yalnız
  // `status|issuetype` için — etiket serbest metindir, `assigned`ın değeri yok.
  // Depo eşlemesi için Jira alanları — yalnız bölüm açıkken ve bir bağlantı
  // varken okunur; okunamazsa alan kimliği elle yazılır.
  const jiraFields = useQuery({
    queryKey: ["jira-fields", jiraConnId],
    enabled: jiraConnId !== null && draft.repoMapOn,
    retry: false,
    queryFn: ({ signal }) =>
      api.get<{ ok: boolean; fields?: readonly JiraFieldOption[]; messageKey?: string }>(
        `/onboarding/jira-fields?connectionId=${encodeURIComponent(jiraConnId ?? "")}`,
        { signal },
      ),
  });
  const jiraFieldOptions = jiraFields.data?.ok ? (jiraFields.data.fields ?? []) : [];
  const jiraFieldsDegradedKey =
    jiraFields.data !== undefined && !jiraFields.data.ok ? jiraFields.data.messageKey : undefined;
  // Seçili projeye bağlı uygulamalar — eşleme satırlarının hedefi.
  const appOptions = routing.data?.projects?.find((p) => p.projectKey === draft.projectKey)?.apps ?? [];

  const matchValues = useQuery({
    queryKey: ["jira-match-values", jiraConnId, draft.projectKey, draft.matchKind],
    enabled:
      jiraConnId !== null &&
      draft.projectKey.trim() !== "" &&
      (draft.matchKind === "status" || draft.matchKind === "issuetype"),
    retry: false,
    queryFn: ({ signal }) =>
      api.get<{ ok: boolean; values?: readonly string[]; degradedKey?: string }>(
        matchValuesUrl(draft.matchKind),
        { signal },
      ),
  });
  const valueOptions = matchValues.data?.ok ? (matchValues.data.values ?? []) : [];
  const valuesDegradedKey = matchValues.data?.ok ? matchValues.data.degradedKey : undefined;

  // Projenin STATÜ adları — statü kapısı ve durum eşlemesi için, `matchKind`den
  // bağımsız (iş tipine tetiklenen kural da ticket'ı statülerde gezdirir).
  const statusNames = useQuery({
    queryKey: ["jira-match-values", jiraConnId, draft.projectKey, "status"],
    enabled: jiraConnId !== null && draft.projectKey.trim() !== "",
    retry: false,
    queryFn: ({ signal }) =>
      api.get<{ ok: boolean; values?: readonly string[] }>(matchValuesUrl("status"), { signal }),
  });
  const statusOptions = statusNames.data?.ok ? (statusNames.data.values ?? []) : [];

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ["listening-rules"] });
  };

  // ── Deneme ────────────────────────────────────────────────────────────────
  // Sonuç, ÜRETİLDİĞİ taslakla birlikte tutulur: form sonradan değişirse tablo
  // artık formdaki kuralı anlatmıyordur ve bunu söylemek zorundayız.
  const [probe, setProbe] = useState<{ draft: ProbeDraft; result: ProbeResult } | null>(null);
  const probeStale = probe !== null && !sameDraft(probe.draft, probeDraftOf(draft));

  const test = useMutation({
    mutationFn: (body: ProbeDraft) => api.post<ProbeResult>("/studio/listening-rules/test", body),
    onSuccess: (result, body) => setProbe({ draft: body, result }),
    onError: (error) => {
      setProbe(null); // eski sonuç yeni kuralın cevabı sanılmasın
      toast.show("error", t(messageKeyOf(error)));
    },
  });
  const onTest = (): void => {
    if (draftIncomplete(draft)) {
      toast.show("error", t("listening.form.incomplete"));
      return;
    }
    test.mutate(probeDraftOf(draft));
  };

  // ── Yazma ─────────────────────────────────────────────────────────────────
  const resetForm = (): void => {
    setEditingRuleId(null);
    setProbe(null);
    // Proje ve bot kalır — bir sonraki kural büyük ihtimalle aynı projede.
    // Statü, kapı ve eşleme kural başına: kalması sonraki kurala önceki kuralın
    // ayarlarını sessizce iliştirirdi.
    setDraft((prev) => ({
      ...emptyDraft(prev.projectKey),
      assigneeAccountId: prev.assigneeAccountId,
      assigneeTouched: prev.assigneeTouched,
      jiraConnectionId: prev.jiraConnectionId,
    }));
  };

  const create = useMutation({
    mutationFn: (body: RuleBody) => api.post<{ rule: ListeningRule }>("/studio/listening-rules", body),
    onSuccess: () => {
      invalidate();
      toast.show("success", t("listening.toast.created"));
      resetForm();
    },
    onError: (error) => toast.show("error", t(messageKeyOf(error))),
  });

  // PUT tam değiştirmedir; form kuralın HER alanını taşır (bkz. draftFromRule).
  const update = useMutation({
    mutationFn: ({ ruleId, body }: { ruleId: string; body: RuleBody }) =>
      api.put<{ rule: ListeningRule }>(`/studio/listening-rules/${ruleId}`, body),
    onSuccess: () => {
      invalidate();
      toast.show("success", t("listening.toast.updated"));
      resetForm();
    },
    onError: (error) => toast.show("error", t(messageKeyOf(error))),
  });

  const onSubmit = (): void => {
    if (draftIncomplete(draft)) {
      toast.show("error", t("listening.form.incomplete"));
      return;
    }
    const priority = priorityOf(draft.priority);
    if (priority === null) {
      toast.show("error", t("listening.form.priority_invalid"));
      return;
    }
    const body = bodyFromDraft(draft, priority);
    if (editingRuleId !== null) update.mutate({ ruleId: editingRuleId, body });
    else create.mutate(body);
  };

  /** Tablodan forma: kural olduğu gibi yüklenir, form ekrana getirilir. */
  const onEdit = (rule: ListeningRule): void => {
    setProbe(null);
    setEditingRuleId(rule.ruleId);
    const conn =
      connections.find(
        (c) => c.botAccountId !== null && c.botAccountId.trim() === rule.assigneeAccountId.trim(),
      )?.id ?? "";
    setDraft(draftFromRule(rule, conn));
    // Form tablonun ÜSTÜNDE; bir düzine kuralda "Düzenle" görünmeyen bir formu
    // doldururdu. Kaydırma bir kolaylık, düzenlemenin kendisi değil — sunmayan
    // ortamda (jsdom) sessizce atlanır.
    requestAnimationFrame(() => {
      const form = formRef.current;
      if (typeof form?.scrollIntoView === "function") {
        form.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  };

  const remove = useMutation({
    mutationFn: (ruleId: string) => api.delete<{ ok?: boolean }>(`/studio/listening-rules/${ruleId}`),
    onSuccess: (_data, ruleId) => {
      invalidate();
      if (editingRuleId === ruleId) resetForm();
      toast.show("success", t("listening.toast.deleted"));
    },
    onError: (error) => toast.show("error", t(messageKeyOf(error))),
  });

  // Hazır kurallar: BFF projenin iş tiplerini okur, tip başına bir kural açar.
  // `reason: issue_types_unavailable` = hiçbir şey yazılmadı, uyarıdır.
  const seed = useMutation({
    mutationFn: (key: string) =>
      api.post<{ created: number; skipped: number; rules: readonly ListeningRule[]; reason?: string }>(
        "/studio/listening-rules/seed-defaults",
        { projectKey: key },
      ),
    onSuccess: ({ created, skipped, reason }) => {
      invalidate();
      if (reason === "issue_types_unavailable") {
        toast.show("warning", t("listening.seed.issue_types_unavailable"));
        return;
      }
      toast.show(
        "success",
        t("listening.seed.toast", { created: String(created), skipped: String(skipped) }),
      );
    },
    onError: (error) => toast.show("error", t(messageKeyOf(error))),
  });
  const onSeed = (): void => {
    const key =
      draft.projectKey.trim() !== ""
        ? draft.projectKey.trim()
        : boundProjects.length === 1
          ? boundProjects[0]!
          : "";
    if (key === "") {
      toast.show("error", t("listening.seed.no_project"));
      return;
    }
    seed.mutate(key);
  };

  // Bot hesabını hizala — kuralların taşıdığı kopyayı bağlantının bildiği
  // kimliğe çeker. Otomatik DEĞİL: hangi ticket'ların alındığı en görünür
  // davranış, operatör bakmıyorken değişmemeli.
  const realign = useMutation({
    mutationFn: () =>
      api.post<{
        accountId: string;
        changed: readonly { ruleId: string; projectKey: string; from: string }[];
        untouched: number;
      }>("/studio/listening-rules/realign-bot", {}),
    onSuccess: ({ accountId, changed }) => {
      invalidate();
      toast.show(
        "success",
        changed.length === 0
          ? t("listening.realign.none")
          : t("listening.realign.done", { count: String(changed.length), account: accountId }),
      );
    },
    onError: (error) => toast.show("error", t(messageKeyOf(error))),
  });

  // ── Türetilen uyarılar ───────────────────────────────────────────────────
  const rules = query.data?.rules ?? [];

  // Bağlı ama kuralsız proje: bağ yeşil görünür, hiçbir ticket dinlenmez.
  // Yalnız iki liste de cevapladıysa — yüklenen liste boşluk kanıtı değil.
  const unlistenedProjects =
    query.isSuccess && routing.isSuccess
      ? boundProjects.filter((key) => !rules.some((rule) => rule.projectKey === key))
      : [];

  // Kuralların bot hesabı vs bağlantının bildiği: AYRIŞMA (kesin) ya da DESEN
  // (`jirauser<sayı>`, DC iç tutamağı — kıyastan bağımsız, çünkü bankada
  // ayrışma YOKTU, arıza vardı).
  const staleRules =
    query.isSuccess && jiraConns.isSuccess && botAccountId
      ? rules.filter((rule) => rule.assigneeAccountId.trim() !== botAccountId.trim())
      : [];
  const internalKeyRules = query.isSuccess
    ? rules.filter((rule) => DC_INTERNAL_KEY.test(rule.assigneeAccountId.trim()))
    : [];
  const identityWarning =
    staleRules.length > 0 ? "stale" : internalKeyRules.length > 0 ? "internal" : null;

  return (
    <div className="scr-stack">
      <Card
        title={t("listening.title")}
        subtitle={t("listening.sub")}
        actions={
          canSeed ? (
            <Button size="sm" busy={seed.isPending} onClick={onSeed} title={t("listening.seed.desc")}>
              {t("listening.seed.action")}
            </Button>
          ) : undefined
        }
      >
        <div className="scr-stack">
          <p className="scr-prose" style={{ margin: 0 }}>
            {t("listening.intro")}
          </p>
          <SweepBanner
            status={sweep.data}
            statusError={sweep.error}
            onRetryStatus={() => void sweep.refetch()}
            canWrite={canWrite}
            run={{
              isPending: sweepNow.isPending,
              isSuccess: sweepNow.isSuccess,
              isError: sweepNow.isError,
              data: sweepNow.data,
              error: sweepNow.error,
              mutate: () => sweepNow.mutate(),
            }}
          />
          {/* Bot hesabı ayrışması — "0 sonuç" ile "yanlış kimlikle soruldu"
              arasındaki farkı söyleyen tek yer. Düğme yalnız yazabilene. */}
          {identityWarning !== null && (
            <div className="scr-note scr-note--warn">
              {identityWarning === "stale"
                ? t("listening.identity.stale", {
                    count: String(staleRules.length),
                    account: botAccountId ?? "",
                  })
                : t("listening.identity.internal", { count: String(internalKeyRules.length) })}
              {canWrite && (
                <div className="scr-actions">
                  <Button variant="primary" size="sm" busy={realign.isPending} onClick={() => realign.mutate()}>
                    {t("listening.identity.realign")}
                  </Button>
                </div>
              )}
            </div>
          )}
          {unlistenedProjects.length > 0 && (
            <div className="scr-note scr-note--warn">
              {t("listening.unlistened.warn", { projects: unlistenedProjects.join(", ") })}
              {canSeed && (
                <div className="scr-actions">
                  {unlistenedProjects.map((key) => (
                    <Button key={key} size="sm" busy={seed.isPending} onClick={() => seed.mutate(key)}>
                      {t("listening.unlistened.seed", { project: key })}
                    </Button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </Card>

      {unbound && (
        <Card title={t("listening.unbound.title")}>
          <p className="scr-hint scr-hint--warn" style={{ margin: 0 }}>
            {t("listening.unbound.body")}{" "}
            <Link to="/projects?tab=onboard" className="scr-link">
              {t("listening.unbound.action")}
            </Link>
          </p>
        </Card>
      )}

      {canWrite && !unbound && (
        <RuleForm
          draft={draft}
          patch={patch}
          editingRuleId={editingRuleId}
          boundProjects={boundProjects}
          botAccountId={botAccountId}
          jiraConnections={connections}
          valueOptions={valueOptions}
          valuesDegradedKey={valuesDegradedKey}
          statusOptions={statusOptions}
          jiraFields={jiraFieldOptions}
          jiraFieldsDegradedKey={jiraFieldsDegradedKey}
          appOptions={appOptions}
          analystOptions={analystOptions}
          engineerOptions={engineerOptions}
          onSubmit={onSubmit}
          onTest={onTest}
          onCancelEdit={resetForm}
          submitting={create.isPending || update.isPending}
          testing={test.isPending}
          probe={probe === null ? null : { result: probe.result, stale: probeStale }}
          formRef={formRef}
        />
      )}

      <Card padded={false}>
        <QueryState
          isPending={query.isPending}
          error={query.error}
          onRetry={() => void query.refetch()}
          skeletonRows={3}
        >
          <RuleTable
            rules={rules}
            canWrite={canWrite}
            onEdit={onEdit}
            onDelete={(rule) => remove.mutate(rule.ruleId)}
            deleting={remove.isPending}
          />
        </QueryState>
      </Card>
    </div>
  );
}
