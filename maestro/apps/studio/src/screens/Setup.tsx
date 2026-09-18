import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, issueDetailsOf, messageKeyOf } from "../api/errors.ts";
import { useApi, useAuth } from "../auth/AuthProvider.tsx";
import { hasAnyRole } from "../auth/types.ts";
import { useT } from "../i18n/I18nProvider.tsx";
import { Button, ButtonLink, Card, useToast } from "../ui/index.ts";
import type {
  JiraConnection,
  JiraProjectsResult,
  OnboardingOptions,
  RoutingView,
  ScmConnection,
  ScmReposResult,
} from "./common/index.ts";
import { usePhrase } from "./common/label.ts";
import type { MatchValueOption } from "./common/match-value.ts";
import { buildStatusMap } from "./common/status-map.ts";
import { IntakePane, ProjectPane, StatusPane, TicketsPane } from "./setup/SetupPanes.tsx";
import type { PaneData } from "./setup/SetupPanes.tsx";
import { DonePane, ReviewPane, type SetupOutcome } from "./setup/ReviewPane.tsx";
import {
  ASSIGNED_MATCH_VALUE,
  DEFAULT_POLL_SECONDS,
  EMPTY_SETUP_DRAFT,
  GATE_STEPS_BY_CHOICE,
  SETUP_STEPS,
  bindsNoRepository,
  flowDefaults,
  flowNeedsRepository,
  intakeChanged,
  intakePolls,
  stepBlockedReason,
  type CommandIntake,
  type SetupDraft,
  type SetupStep,
} from "./setup/model.ts";

/**
 * Screen: setup — the guided "Kurulum sihirbazı".
 *
 * `/projects` holds the expert tabs in the platform's own vocabulary. This
 * screen is for the other person — a bank operator whose job is approving
 * Jira tickets — and asks five questions in the order the ANSWERS depend on
 * each other, in outcome language:
 *
 *   1 hangi proje & uygulama → the Jira project and the data class
 *   2 hangi ticket'lar       → the flow (which decides the defaults), the repo,
 *                              the trigger, the status gate, the human approvals
 *   3 Jira durumları         → the optional status map, OFF by default
 *   4 Jira ile iletişim      → webhook / yoklama / ikisi, the command intake
 *   5 özet & kaydet          → in sentences, then the writes — and the
 *                              binding's approval, attempted on the spot
 *
 * Nothing here is a new capability: every field maps to something `/projects`
 * can set, every write goes to an endpoint that exists, and the two screens
 * share `common/status-map.ts` so a status map looks the same on the wire
 * whichever one wrote it.
 *
 * ONE DRAFT, never per-step state: the panes are pure functions of a single
 * object that navigation does not touch.
 */

/** Mirrors the BFF's WRITE_ROLES for the listening rule the wizard writes. */
const WRITE_ROLES = ["admin"] as const;

/** What `GET /studio/command-intake` answers. */
interface CommandIntakeStatus {
  readonly mode: CommandIntake;
  readonly pollSeconds: number;
  readonly canReadComments: boolean;
  readonly appliesLive: boolean;
  readonly source: "param" | "env" | "default";
}

/** The two parameter keys step 5 writes (`packages/db/src/params-defaults.ts`). */
const INTAKE_PARAM_KEY = "jira.command_intake";
const POLL_SECONDS_PARAM_KEY = "jira.poll_seconds";

export function SetupScreen(): ReactNode {
  const t = useT();
  const api = useApi();
  const toast = useToast();
  const phrase = usePhrase();
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const canWrite = hasAnyRole(session, WRITE_ROLES);

  const [draft, setDraft] = useState<SetupDraft>(EMPTY_SETUP_DRAFT);
  const [stepIndex, setStepIndex] = useState(0);
  const step: SetupStep = SETUP_STEPS[stepIndex]!;
  const [finished, setFinished] = useState<SetupOutcome | null>(null);
  // A failure the operator can act on, beside the save button rather than only
  // as a toast; plus the field-level violations of a validation 400.
  const [saveProblem, setSaveProblem] = useState<string | null>(null);
  const [saveProblemIssues, setSaveProblemIssues] = useState<readonly string[]>([]);

  const patch = (next: Partial<SetupDraft>): void => {
    setDraft((current) => ({ ...current, ...next }));
    setSaveProblem(null);
    setSaveProblemIssues([]);
  };

  // ── the live lists, read from exactly the endpoints /projects reads ────────

  const options = useQuery({
    queryKey: ["onboarding-options"],
    queryFn: ({ signal }) => api.get<OnboardingOptions>("/onboarding/options", { signal }),
    retry: false,
  });
  const jiraConnections = useQuery({
    queryKey: ["onboarding-jira-connections"],
    queryFn: ({ signal }) =>
      api.get<{ connections: readonly (JiraConnection & { botAccountId?: string | null })[] }>(
        "/onboarding/jira-connections",
        { signal },
      ),
    retry: false,
  });
  const jiraConnList = jiraConnections.data?.connections ?? [];
  const scmConnections = useQuery({
    queryKey: ["onboarding-scm-connections"],
    queryFn: ({ signal }) =>
      api.get<{ connections: readonly ScmConnection[] }>("/onboarding/scm-connections", { signal }),
    retry: false,
  });
  const scmConnList = scmConnections.data?.connections ?? [];

  /**
   * TEK BAĞLANTI VARSA SORULMAZ — kendiliğinden seçilir.
   *
   * Ölçülen şikâyet: tek Jira'lı kurulumda kutu "Seçiniz" bekliyor ve ipucu
   * "tek seçenek gelir" diyordu; operatör tek seçenekli bir soruya cevap
   * vermek zorunda kalıyordu. Tahmin yok: yalnız liste gerçekten tek
   * elemanlıysa. Aynı kural depo bağlantısı için de geçerli — depo listesi
   * böylece "Hangi ticket'lar" adımında açık gelir.
   */
  const soleJiraConn = jiraConnList.length === 1 ? jiraConnList[0]!.id : undefined;
  useEffect(() => {
    if (soleJiraConn !== undefined && draft.jiraConnectionId === "") {
      setDraft((current) => ({ ...current, jiraConnectionId: soleJiraConn }));
    }
  }, [soleJiraConn, draft.jiraConnectionId]);
  const soleScmConn = scmConnList.length === 1 ? scmConnList[0]!.id : undefined;
  useEffect(() => {
    if (soleScmConn !== undefined && draft.connectionId === "") {
      setDraft((current) => ({ ...current, connectionId: soleScmConn }));
    }
  }, [soleScmConn, draft.connectionId]);
  const jiraProjects = useQuery({
    queryKey: ["onboarding-jira-projects", draft.jiraConnectionId],
    enabled: draft.jiraConnectionId !== "",
    retry: false,
    queryFn: ({ signal }) =>
      api.get<JiraProjectsResult>(
        `/onboarding/jira-projects?connectionId=${encodeURIComponent(draft.jiraConnectionId)}`,
        { signal },
      ),
  });
  const scmRepos = useQuery({
    queryKey: ["onboarding-scm-repos", draft.connectionId],
    enabled: draft.connectionId !== "",
    retry: false,
    queryFn: ({ signal }) =>
      api.get<ScmReposResult>(
        `/onboarding/scm-repos?connectionId=${encodeURIComponent(draft.connectionId)}`,
        { signal },
      ),
  });
  // Already-bound projects: the summary must not promise a four-eyes approval
  // for a project that is already live.
  const routing = useQuery({
    queryKey: ["routing"],
    queryFn: ({ signal }) => api.get<RoutingView>("/routing", { signal }),
    retry: false,
  });
  const boundProjects = routing.data?.projects ?? [];
  const alreadyBound = draft.jiraProject !== "" && boundProjects.some((p) => p.projectKey === draft.jiraProject);

  // How ticket commands reach this platform TODAY — step 5's starting point
  // and its capability check. Soft failure: an older BFF has no such route.
  const intake = useQuery({
    queryKey: ["command-intake"],
    queryFn: ({ signal }) => api.get<CommandIntakeStatus>("/studio/command-intake", { signal }),
    retry: false,
  });
  // Adopt the platform's current answer once — never after the operator has
  // touched the radio group.
  const [intakeTouched, setIntakeTouched] = useState(false);
  const intakeMode = intake.data?.mode;
  const intakePollSeconds = intake.data?.pollSeconds;
  useEffect(() => {
    if (intakeTouched || intakeMode === undefined) return;
    setDraft((current) => ({
      ...current,
      commandIntake: intakeMode,
      // A platform that is not polling reports 0, which is the ABSENCE of an
      // interval, not one to show in a field.
      pollSeconds:
        typeof intakePollSeconds === "number" && intakePollSeconds > 0 ? intakePollSeconds : DEFAULT_POLL_SECONDS,
    }));
  }, [intakeMode, intakePollSeconds, intakeTouched]);

  /**
   * TEK PLATFORM PROFİLİ VARSA TASLAK KENDİ DOLAR.
   *
   * Ekran o durumda kutuyu çizmiyor (soracak bir şey yok), ama taslağın boş
   * kalması `POST /onboarding`in `adoRepo`+`platform` çiftini birlikte
   * istemesini kırardı — ve kural kaydı `assertMappedAppsExist` duvarına
   * çarpardı. Gizlenen bir soru cevapsız bırakılmaz, CEVAPLANIR.
   *
   * Tahmin yok: yalnız liste gerçekten tek elemanlıysa. Birden fazlaysa kutu
   * duruyor ve operatör seçiyor — yanlış tahmin `platform_mismatch`e ya da
   * yanlış araç zincirinde derlemeye çıkardı.
   */
  const platformList = options.data?.platforms ?? [];
  const soleplatform = platformList.length === 1 ? platformList[0] : undefined;
  useEffect(() => {
    if (soleplatform !== undefined && draft.platform === "") {
      setDraft((current) => ({ ...current, platform: soleplatform }));
    }
  }, [soleplatform, draft.platform]);

  // The bot's own accountId, learned when a Jira connection was tested — so
  // step 2 pre-fills itself instead of asking for a hand-copied GUID.
  const botAccountId = jiraConnList.find((c) => c.botAccountId)?.botAccountId ?? null;
  const [assigneeTouched, setAssigneeTouched] = useState(false);
  useEffect(() => {
    if (!assigneeTouched && draft.assigneeAccountId === "" && botAccountId) {
      setDraft((current) => ({ ...current, assigneeAccountId: botAccountId }));
    }
  }, [botAccountId, assigneeTouched, draft.assigneeAccountId]);

  // The Jira connection the match values are read through: the one picked in
  // step 1, falling back to the first configured connection.
  const matchConnId = draft.jiraConnectionId !== "" ? draft.jiraConnectionId : (jiraConnList[0]?.id ?? null);

  // The project's real issue types / statuses. Fetched ONLY for the two kinds
  // the endpoint understands; `assigned` and `label` fall back to free text.
  //
  // `options` + `teamManaged` decide what the rule STORES: on a team-managed
  // project JQL matches by id only, so the wizard saves the id the way the
  // listening form does (`common/match-value.ts`) — a rule saved by NAME on
  // such a project found zero tickets forever, and this screen was the one
  // still doing it.
  const matchValues = useQuery({
    queryKey: ["jira-match-values", matchConnId, draft.jiraProject, draft.matchKind],
    enabled:
      matchConnId !== null &&
      draft.jiraProject !== "" &&
      (draft.matchKind === "status" || draft.matchKind === "issuetype"),
    retry: false,
    queryFn: ({ signal }) =>
      api.get<{
        ok: boolean;
        values?: readonly string[];
        options?: readonly MatchValueOption[];
        teamManaged?: boolean;
        degradedKey?: string;
      }>(
        `/onboarding/jira-match-values?connectionId=${encodeURIComponent(matchConnId ?? "")}` +
          `&project=${encodeURIComponent(draft.jiraProject)}&kind=${draft.matchKind}`,
        { signal },
      ),
  });
  // The STATUS names, pinned to kind=status whatever the rule matches on: the
  // status gate (step 2) and the status map (step 3) both need them.
  const statusNames = useQuery({
    queryKey: ["jira-match-values", matchConnId, draft.jiraProject, "status"],
    enabled: matchConnId !== null && draft.jiraProject !== "",
    retry: false,
    queryFn: ({ signal }) =>
      api.get<{ ok: boolean; values?: readonly string[] }>(
        `/onboarding/jira-match-values?connectionId=${encodeURIComponent(matchConnId ?? "")}` +
          `&project=${encodeURIComponent(draft.jiraProject)}&kind=status`,
        { signal },
      ),
  });

  const projectsBody = jiraProjects.data;
  const reposBody = scmRepos.data;
  const data: PaneData = {
    jiraConnections: jiraConnList.map((c) => ({
      id: c.id,
      label: `${c.displayName} · ${t(`onboard.jira.kind.${c.kind}`)}`,
    })),
    jiraProjects: projectsBody?.ok === true ? projectsBody.projects : [],
    jiraProjectsLoading: draft.jiraConnectionId !== "" && jiraProjects.isFetching,
    jiraProjectsError:
      projectsBody !== undefined && projectsBody.ok === false
        ? t(projectsBody.messageKey, projectsBody.messageParams ?? {})
        : jiraProjects.isError
          ? t(messageKeyOf(jiraProjects.error))
          : null,
    scmConnections: scmConnList.map((c) => ({
      id: c.id,
      label: `${c.displayName} · ${t(`onboard.scm.kind.${c.kind}`)}`,
    })),
    // Only an ANSWERED request may be turned into "this install has no repository".
    scmConnectionCount: scmConnections.isSuccess ? scmConnList.length : null,
    scmRepos: reposBody?.ok === true ? reposBody.repos.map((r) => r.fullName) : [],
    scmReposLoading: draft.connectionId !== "" && scmRepos.isFetching,
    scmReposError:
      reposBody !== undefined && reposBody.ok === false
        ? t(reposBody.messageKey, reposBody.messageParams ?? {})
        : scmRepos.isError
          ? t(messageKeyOf(scmRepos.error))
          : null,
    platforms: options.data?.platforms ?? [],
    matchValues: matchValues.data?.ok === true ? (matchValues.data.values ?? []) : [],
    matchValueOptions: matchValues.data?.ok === true ? (matchValues.data.options ?? []) : [],
    // `?? false` is the fail-soft: a BFF that could not read the project
    // resource reports nothing, and "nothing" must mean today's behaviour.
    matchValuesTeamManaged: (matchValues.data?.ok === true ? matchValues.data.teamManaged : false) ?? false,
    matchValuesNote:
      matchValues.data?.ok === true && matchValues.data.degradedKey !== undefined
        ? t(matchValues.data.degradedKey)
        : null,
    statusNames: statusNames.data?.ok === true ? (statusNames.data.values ?? []) : [],
    botKnown: botAccountId !== null,
    canReadComments: intake.data?.canReadComments,
    intakeAppliesLive: intake.data?.appliesLive,
  };

  // ── prerequisites and failed reads ────────────────────────────────────────

  // Only checked once the lists have actually loaded; a failed request is not
  // evidence of an empty list either.
  const missingJira = jiraConnections.isSuccess && jiraConnList.length === 0;
  const missingScm = flowNeedsRepository(draft.flowType) && scmConnections.isSuccess && scmConnList.length === 0;
  // A list that could not be read at all is said, with a retry — a silently
  // empty dropdown reads as "this install has nothing", which is a different
  // and wrong claim.
  const loadFailures = [
    { key: "setup.load.jira_connections", query: jiraConnections },
    { key: "setup.load.scm_connections", query: scmConnections },
    { key: "setup.load.options", query: options },
  ].filter((entry) => entry.query.isError);

  // ── the writes ────────────────────────────────────────────────────────────

  /**
   * Save is up to THREE requests, in a deliberate order: the command intake
   * first (it decides whether an approval is ever READ, and must not sit
   * behind a rule that can legitimately fail on a duplicate); the listening
   * rule second (applies immediately, can fail on a duplicate trigger); the
   * binding proposal last (waits for a second admin, so it is never filed for
   * a rule that did not save). An already-bound project skips the proposal.
   *
   * Then a FOURTH, best-effort: `POST /onboarding/approve`. The BFF lets a
   * master admin approve their own proposal (a single-admin install must not
   * deadlock), so the wizard tries it on the spot instead of sending the
   * operator to the queue to approve their own package. `409 self_approval`
   * is the four-eyes answer — a second admin will do it — and is reported as
   * such, not as a failure; any other error is named, with the queue linked.
   */
  const save = useMutation({
    mutationFn: async (input: SetupDraft): Promise<SetupOutcome> => {
      // Skipped when the answer has not changed: this is a GLOBAL setting in a
      // per-project wizard, and a fourth project must not mint a parameter
      // version for a value nobody touched.
      if (intakeChanged(input, intake.data)) {
        await api.put("/settings", {
          changes: [
            { key: INTAKE_PARAM_KEY, scopeRef: null, value: input.commandIntake },
            {
              key: POLL_SECONDS_PARAM_KEY,
              scopeRef: null,
              value: intakePolls(input.commandIntake) ? input.pollSeconds : 0,
            },
          ],
        });
      }

      /*
       * ÖNCE ENVANTER, SONRA KURAL — sıra ölçülmüş bir arızanın karşılığı.
       *
       * Kural gövdesi `repoMap: {appId: <depo>}` taşıyor ve sunucu o adın
       * `Application` tablosunda satırı olmasını zorunlu tutuyor
       * (`assertMappedAppsExist` — yoksa koşu satırı yabancı anahtarla patlar,
       * OPS-121). O satırı YAZAN ise `POST /onboarding`. Bir dönem kural önce
       * gönderiliyordu: yeni bir depoyla ilk kurulum 6. adımda
       * `listening_repo_map_unknown_app` ile düşüyordu — operatör depoyu
       * kutudan seçmişken "tanınmayan depo" okuyordu. Testler yakalamadı,
       * çünkü iki ucu da ayrı ayrı mock'luyordu; sıra kimseye görünmüyordu.
       *
       * Bağlı proje: teklif yok, ama depo yine envantere girmeli —
       * `POST /onboarding/apps` tam bunun için var ve bağlı projede çalışır.
       */
      let proposed = false;
      if (!alreadyBound) {
        const defaults = flowDefaults(input.flowType);
        await api.post<{ proposalId: string }>("/onboarding", {
          jiraProject: input.jiraProject,
          /*
           * DEPO GÖNDERİLİR ama BAĞLAMAYA YAZILMAZ — `bindDefaultApp: false`.
           *
           * İki ayrı şey var ve ayrılmaları gerekti:
           *
           *  1. ENVANTER: seçilen depo `Application` tablosuna yazılır. Kuralın
           *     eşlemesi bu adı gösteriyor ve `assertMappedAppsExist` satırın
           *     var olmasını zorunlu kılıyor — yoksa alım depoyu klonluyor ve
           *     koşu satırı yabancı anahtar hatasıyla patlıyor (OPS-121).
           *     Sihirbaz bir dönem hiç göndermiyordu ve kural kaydı bu duvara
           *     çarpıyordu.
           *
           *  2. BAĞLAMA VARSAYILANI: yazılMAZ. Sorunlu olan yalnız buydu —
           *     eşleme cevap veremediğinde sessizce devreye giren son çare.
           *
           * Aşağıdaki eski yorum birinciyi de kaybediyordu:
           *
           * Sihirbaz bir dönem burada `adoRepo`/`platform` gönderiyordu ve bu
           * çift proje BAĞLAMASINA yazılıyordu. Bağlamadaki depo ise yalnızca
           * SON ÇAREYDİ: kuralın eşlemesi cevap veremediğinde sessizce devreye
           * giren bir varsayılan. Canlıda ölçülen sonuç, operatörün eşlemenin
           * çalıştığını sanmasıydı — oysa depo hiç eşleşmeden, varsayılandan
           * geliyordu.
           *
           * Depo KARARI artık tek yerden gelir: dinleme kuralının eşlemesi.
           * Buradaki gönderim yalnız ENVANTER içindir.
           */
          ...(bindsNoRepository(input)
            ? {}
            : { adoRepo: input.repoFullName, platform: input.platform, bindDefaultApp: false }),
          // The operator's ANSWER; the BFF falls back to `gizli` only when absent.
          dataClass: input.dataClass,
          ...defaults,
        });
        proposed = true;
      } else if (!bindsNoRepository(input)) {
        await api.post("/onboarding/apps", {
          jiraProject: input.jiraProject,
          adoRepo: input.repoFullName,
          platform: input.platform,
        });
      }

      await api.post<{ rule: unknown }>("/studio/listening-rules", {
        projectKey: input.jiraProject,
        assigneeAccountId: input.assigneeAccountId.trim(),
        matchKind: input.matchKind,
        // An `assigned` rule compares no field, but the column is NOT NULL and
        // carries the unique trigger index, so it gets the literal both sides
        // agree on.
        matchValue: input.matchKind === "assigned" ? ASSIGNED_MATCH_VALUE : input.matchValue.trim(),
        flowType: input.flowType,
        // The wizard never offers per-role agent overrides; sent as null so
        // the rule has the same shape as one the expert screen writes.
        analystVariantId: null,
        engineerVariantId: null,
        // The same body the summary was built from: switch, flow gating and
        // blank-field omission all live in `buildStatusMap`.
        statusMap: buildStatusMap(input.statusOn, input.statusDraft, input.reassignOnNeedInfo, input.flowType),
        // Empty → null, exactly as the expert screen sends it: "no status
        // restriction" has ONE representation on the wire.
        allowedStatuses: input.allowedStatuses.length === 0 ? null : [...input.allowedStatuses],
        // `null` = "no selection" (risk-tiered); an EMPTY LIST is the opposite
        // answer ("no gates at all") and must travel as such.
        /*
         * HER ZAMAN `{steps}` — `null` ASLA.
         *
         * `null` "operatör seçmedi" demek ve kapı dizisini risk katmanına
         * bırakıyor. Radyoda bir seçenek her zaman seçili olduğu için operatör
         * her zaman seçmiş olur; `null` göndermek sorduğu soruyu sonra yok
         * saymak olurdu.
         *
         * Bunun bir bedeli var ve ekran onu söylüyor: seçim risk seviyesinden
         * BAĞIMSIZDIR. Risk katmanına göre değişen kapı dizisi isteyen operatör
         * Dinleme kuralları ekranından "seçim yok"u işaretler.
         */
        gateSteps: { steps: [...GATE_STEPS_BY_CHOICE[input.gateChoice]] },
        /*
         * DEPO BURAYA YAZILIR — kurala, bağlamaya değil.
         *
         * Depo bir dönem proje BAĞLAMASINA yazılıyordu ve orada yalnızca SON
         * ÇAREYDİ: kuralın eşlemesi cevap veremediğinde sessizce devreye giren
         * bir varsayılan. Operatör panelde bir depo adı görüyor ve eşlemenin
         * çalıştığını sanıyordu; canlıda ölçülen yanlış-anlatımın kaynağı buydu.
         * O halka zincirden çıkarıldı.
         *
         * Sabit eşleme (`field: "*"`) "bu kuralın BÜTÜN ticket'ları şu depoya"
         * demek — bağlama varsayılanının yaptığı işin açıkça yazılmış hâli, ve
         * artık tek kaynak. Alan bazlı eşleme ("İş Ailesi = Krediler → şu depo")
         * kurulum sonrası Dinleme ekranından tanımlanır.
         *
         * Yalnız analiz yapan kural depo istemez; `bindsNoRepository` o hâli
         * tanıyor ve alan hiç gönderilmiyor.
         */
        ...(bindsNoRepository(input)
          ? {}
          : { repoMap: { field: "*", entries: [{ value: "*", appId: input.repoFullName }] } }),
      });

      if (!proposed) return { outcome: "already_bound" };
      // After the rule, never before: approval seeds the project's default
      // rules, and a seed landing on the wizard's trigger would turn the
      // rule POST into a duplicate.
      try {
        await api.post("/onboarding/approve", { projectKey: input.jiraProject });
        return { outcome: "bound" };
      } catch (error) {
        if (error instanceof ApiError && error.code === "self_approval") return { outcome: "awaiting" };
        return { outcome: "approve_failed", errorKey: messageKeyOf(error) };
      }
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["listening-rules"] });
      void queryClient.invalidateQueries({ queryKey: ["routing"] });
      void queryClient.invalidateQueries({ queryKey: ["onboarding-pending"] });
      void queryClient.invalidateQueries({ queryKey: ["command-intake"] });
      setFinished(result);
      toast.show("success", t("setup.toast.saved"));
    },
    onError: (error) => {
      // The duplicate trigger, explained rather than reported.
      if (error instanceof ApiError && error.code === "duplicate_listening_rule") {
        setSaveProblem("setup.error.duplicate_rule");
        return;
      }
      setSaveProblem(messageKeyOf(error));
      setSaveProblemIssues(issueDetailsOf(error));
    },
  });

  // ── navigation ────────────────────────────────────────────────────────────

  const blockedAt = (index: number): string | null =>
    stepBlockedReason(SETUP_STEPS[index]!, draft, data.scmConnectionCount, data.canReadComments);
  const blocked = blockedAt(stepIndex);
  const isLast = stepIndex === SETUP_STEPS.length - 1;
  /**
   * A step on the strip is reachable when every step BEFORE it is answered.
   * Going back is always allowed; going forward again after a step back is
   * allowed exactly as far as the answers carry — jumping past an unanswered
   * question is how a wizard saves a half-filled draft.
   */
  const canJumpTo = (index: number): boolean => {
    for (let i = 0; i < index; i += 1) if (blockedAt(i) !== null) return false;
    return true;
  };
  const goTo = (index: number): void => {
    setSaveProblem(null);
    setSaveProblemIssues([]);
    setStepIndex(Math.max(0, Math.min(SETUP_STEPS.length - 1, index)));
  };

  if (finished !== null) {
    return (
      <div className="scr-stack">
        <DonePane
          draft={draft}
          result={finished}
          matchValueOptions={data.matchValueOptions}
          onAgain={() => {
            // A second project from a clean draft — but keep the bot account,
            // which is a property of the platform rather than of the project.
            setDraft({ ...EMPTY_SETUP_DRAFT, assigneeAccountId: draft.assigneeAccountId });
            setStepIndex(0);
            setFinished(null);
          }}
        />
      </div>
    );
  }

  return (
    <div className="scr-stack">
      <Card title={t("setup.title")} subtitle={t("setup.sub")}>
        {/* The step strip: where the operator is, and how much is left. */}
        <ol className="scr-wiz">
          {SETUP_STEPS.map((id, i) => (
            <li key={id}>
              <button
                type="button"
                className={
                  "scr-wiz__step" + (i === stepIndex ? " scr-wiz__step--on" : "") + (i < stepIndex ? " scr-wiz__step--done" : "")
                }
                disabled={i !== stepIndex && !canJumpTo(i)}
                aria-current={i === stepIndex ? "step" : undefined}
                onClick={() => goTo(i)}
              >
                {i + 1} · {t(`setup.step.${id}`)}
              </button>
            </li>
          ))}
        </ol>
        {/* What is ALREADY connected, before the wizard asks for anything new. */}
        {boundProjects.length > 0 && (
          <p className="scr-hint">
            {t("setup.bound.line")}{" "}
            {boundProjects.map((project, i) => (
              <span key={project.projectKey}>
                {i > 0 && ", "}
                <strong className="scr-mono">{project.projectKey}</strong>
                {project.noteKey === undefined || project.noteKey === ""
                  ? ""
                  : ` (${phrase(project.noteKey, project.noteParams)})`}
              </span>
            ))}
          </p>
        )}
        {/* A list that could not be read: named, with a retry. */}
        {loadFailures.map((entry) => (
          <div key={entry.key} className="scr-note scr-note--danger scr-mt-2">
            {t(entry.key)} {t(messageKeyOf(entry.query.error))}{" "}
            <Button size="sm" onClick={() => void entry.query.refetch()}>
              {t("action.retry")}
            </Button>
          </div>
        ))}
        {/* A prerequisite the operator cannot solve from this page, linked to
            the screen that fixes it. */}
        {(missingJira || missingScm) && (
          <div className="scr-note scr-note--warn scr-mt-2">
            {missingJira ? t("setup.prereq.no_jira") : t("setup.prereq.no_scm")}{" "}
            <ButtonLink size="sm" to="/settings">
              {t("setup.prereq.open_settings")}
            </ButtonLink>
          </div>
        )}
        {!canWrite && <div className="scr-note scr-note--warn scr-mt-2">{t("setup.blocked.read_only")}</div>}
      </Card>

      <Card title={t(`setup.${step}.title`)} subtitle={t(`setup.${step}.sub`)}>
        {step === "project" && <ProjectPane draft={draft} data={data} onChange={patch} />}
        {step === "tickets" && (
          <TicketsPane
            draft={draft}
            data={data}
            onChange={(next) => {
              if (next.assigneeAccountId !== undefined) setAssigneeTouched(true);
              patch(next);
            }}
          />
        )}
        {step === "status" && <StatusPane draft={draft} data={data} onChange={patch} />}
        {step === "intake" && (
          <IntakePane
            draft={draft}
            data={data}
            onChange={(next) => {
              if (next.commandIntake !== undefined || next.pollSeconds !== undefined) setIntakeTouched(true);
              patch(next);
            }}
          />
        )}
        {step === "review" && (
          <ReviewPane
            draft={draft}
            alreadyBound={alreadyBound}
            intakeAppliesLive={data.intakeAppliesLive}
            matchValueOptions={data.matchValueOptions}
          />
        )}

        <div className="scr-actions setup-actions">
          <Button disabled={stepIndex === 0} onClick={() => goTo(stepIndex - 1)}>
            {t("setup.action.back")}
          </Button>
          {isLast ? (
            <Button variant="success" busy={save.isPending} disabled={!canWrite} onClick={() => save.mutate(draft)}>
              {t("setup.action.save")}
            </Button>
          ) : (
            <Button variant="primary" disabled={blocked !== null} onClick={() => goTo(stepIndex + 1)}>
              {t("setup.action.next")}
            </Button>
          )}
          {/* The optional step says so on the button itself. */}
          {step === "status" && !draft.statusOn && <span className="scr-hint">{t("setup.status.skip_hint")}</span>}
        </div>
        {/* WHY the button is dead, in the operator's own terms and right where they are looking. */}
        {blocked !== null && <div className="scr-note scr-note--warn scr-mt-2">{t(blocked)}</div>}
        {saveProblem !== null && (
          <div className="scr-note scr-note--danger scr-mt-2">
            {t(saveProblem)}
            {/* The violated fields, as the BFF's own field/message lines. */}
            {saveProblemIssues.length > 0 && (
              <ul className="scr-list">
                {saveProblemIssues.map((issue) => (
                  <li key={issue} className="scr-mono">
                    {issue}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
