import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useSearchParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { messageKeyOf } from "../api/errors.ts";
import { useApi, useAuth } from "../auth/AuthProvider.tsx";
import { hasAnyRole } from "../auth/types.ts";
import { useT } from "../i18n/I18nProvider.tsx";
import { Badge, Button, Card, Input, Select, Table, useToast } from "../ui/index.ts";
import type { BadgeTone, Column } from "../ui/index.ts";
import type { RoutingView } from "./common/index.ts";
import { QueryState } from "./shared/QueryState.tsx";
import "./shared/screens.css";

/**
 * Screen: listening — the "dinleme kuralları" surface.
 *
 * Turns Maestro's discovery from hard-coded code into rows an admin edits here:
 * "in project X, a ticket assigned to the bot whose <status|issuetype> is
 * <value> runs as <analiz|duzeltme|gelistirme>". Backed by the real DB table
 * (migration 0011) through `/studio/listening-rules`, and — for the running
 * pilot to actually pick the rules up — mirrored to the pilot's own live store
 * via `/studio/pilot/listening` on every write (the pilot cannot read the DB).
 *
 * WRITES ARE ADMIN-ONLY, mirroring the BFF's WRITE_ROLES. A tech-lead can read
 * the table but the form is hidden; the BFF is the real gate (a viewer who
 * forged the request still gets a 403).
 */

/** Mirrors the BFF WRITE_ROLES for the listening surface. */
const WRITE_ROLES = ["admin"] as const;

type FlowType = "analiz" | "duzeltme" | "gelistirme";
type MatchKind = "status" | "issuetype";

interface ListeningRule {
  readonly ruleId: string;
  readonly projectKey: string;
  readonly assigneeAccountId: string;
  readonly matchKind: MatchKind;
  readonly matchValue: string;
  readonly flowType: FlowType;
  readonly priority: number;
  readonly enabled: boolean;
  /** Agent variant for the analysis side; null/absent → the default agent. */
  readonly analystVariantId?: string | null;
  /** Agent variant for the engineering side; null/absent → the default agent. */
  readonly engineerVariantId?: string | null;
}

/** The slice of `GET /variants` this screen needs: id + role, for filtering. */
interface VariantOption {
  readonly variantId: string;
  readonly role: string;
}

const FLOW_TONE: Readonly<Record<FlowType, BadgeTone>> = {
  analiz: "blue",
  duzeltme: "amber",
  gelistirme: "green",
};

export function ListeningScreen(): ReactNode {
  const t = useT();
  const api = useApi();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const canWrite = hasAnyRole(session, WRITE_ROLES);

  const query = useQuery({
    queryKey: ["listening-rules"],
    queryFn: ({ signal }) =>
      api.get<{ rules: readonly ListeningRule[] }>("/studio/listening-rules", { signal }),
    retry: false,
  });

  // The bound projects, so the operator PICKS one instead of typing a key from
  // memory. A rule on a project that is not bound never fires — a dropdown of
  // real bindings makes that mistake impossible.
  const routing = useQuery({
    queryKey: ["routing"],
    queryFn: ({ signal }) => api.get<RoutingView>("/routing", { signal }),
  });
  const boundProjects = routing.data?.projects?.map((p) => p.projectKey) ?? [];

  // The Maestro Bot's own accountId, learned when a Jira connection was tested.
  // With it, the "Bot kullanıcısı" field pre-fills itself instead of asking the
  // operator to hand-copy a 40-char GUID from a Jira profile URL. `null` until a
  // connection has been tested once — then the field falls back to free text.
  const jiraConns = useQuery({
    queryKey: ["onboarding-jira-connections"],
    queryFn: ({ signal }) =>
      api.get<{ connections: readonly { id: string; botAccountId: string | null }[] }>(
        "/onboarding/jira-connections",
        { signal },
      ),
  });
  const botAccountId =
    jiraConns.data?.connections?.find((c) => c.botAccountId)?.botAccountId ?? null;
  // The Jira connection to read match values through (first enabled one).
  const jiraConnId = jiraConns.data?.connections?.[0]?.id ?? null;

  // Form state for a new rule. The project is pre-filled from `?projectKey=` when
  // an operator arrives here straight from approving an onboarding package (M93),
  // so they land on the rule editor for the project they just bound.
  const [searchParams] = useSearchParams();
  const [projectKey, setProjectKey] = useState(searchParams.get("projectKey") ?? "");
  const [assigneeAccountId, setAssigneeAccountId] = useState("");
  // Pre-fill the bot id once it is known and the operator has not typed their
  // own. Runs when the query resolves; a manual edit is never overwritten.
  const [assigneeTouched, setAssigneeTouched] = useState(false);
  useEffect(() => {
    if (!assigneeTouched && assigneeAccountId === "" && botAccountId) {
      setAssigneeAccountId(botAccountId);
    }
  }, [botAccountId, assigneeTouched, assigneeAccountId]);
  const [matchKind, setMatchKind] = useState<MatchKind>("issuetype");
  const [matchValue, setMatchValue] = useState("");
  const [flowType, setFlowType] = useState<FlowType>("analiz");
  // Which agent variant runs each side of the flow. "" means "default agent"
  // and is sent as null — the pilot then picks its own.
  const [analystVariantId, setAnalystVariantId] = useState("");
  const [engineerVariantId, setEngineerVariantId] = useState("");

  // The agent-variant catalogue, for the two per-role dropdowns. A platform
  // without the variants surface (503) simply leaves both lists empty and the
  // selects offer only "default agent" — the rule still saves.
  const variants = useQuery({
    queryKey: ["variants"],
    queryFn: ({ signal }) =>
      api.get<{ variants: readonly VariantOption[] }>("/variants", { signal }),
    retry: false,
  });
  const analystOptions = (variants.data?.variants ?? []).filter((v) => v.role === "analyst");
  const engineerOptions = (variants.data?.variants ?? []).filter((v) => v.role === "engineer");

  // The real status / issue-type names for the chosen project, read live off
  // Jira. Turns "Değer" from free text (silent typos) into a dropdown of exactly
  // the names Jira uses. Only runs once a project AND a Jira connection exist;
  // any failure (connection down, project unreadable) leaves the list empty and
  // the field falls back to free text.
  const matchValues = useQuery({
    queryKey: ["jira-match-values", jiraConnId, projectKey, matchKind],
    enabled: jiraConnId !== null && projectKey.trim() !== "",
    retry: false,
    queryFn: ({ signal }) =>
      api.get<{ ok: boolean; values?: readonly string[] }>(
        `/onboarding/jira-match-values?connectionId=${encodeURIComponent(jiraConnId ?? "")}` +
          `&project=${encodeURIComponent(projectKey.trim())}&kind=${matchKind}`,
        { signal },
      ),
  });
  const valueOptions = matchValues.data?.ok ? (matchValues.data.values ?? []) : [];

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ["listening-rules"] });
  };

  const create = useMutation({
    mutationFn: (body: Omit<ListeningRule, "ruleId" | "priority" | "enabled">) =>
      api.post<{ rule: ListeningRule }>("/studio/listening-rules", body),
    onSuccess: () => {
      invalidate();
      // Mirror to the live pilot so discovery picks the rule up without a
      // restart. Best-effort: the DB is the source of truth, and a pilot that is
      // simply down must not fail the DB write the admin just saw succeed.
      void api.post("/studio/pilot/listening", { action: "reload" }).catch(() => undefined);
      toast.show("success", t("listening.toast.created"));
      setMatchValue("");
    },
    onError: (error) => toast.show("error", t(messageKeyOf(error))),
  });

  const remove = useMutation({
    mutationFn: (ruleId: string) =>
      api.delete<{ ok?: boolean }>(`/studio/listening-rules/${ruleId}`),
    onSuccess: () => {
      invalidate();
      void api.post("/studio/pilot/listening", { action: "reload" }).catch(() => undefined);
      toast.show("success", t("listening.toast.deleted"));
    },
    onError: (error) => toast.show("error", t(messageKeyOf(error))),
  });

  const rules = query.data?.rules ?? [];

  const onSubmit = (): void => {
    if (projectKey.trim() === "" || assigneeAccountId.trim() === "" || matchValue.trim() === "") {
      toast.show("error", t("listening.form.incomplete"));
      return;
    }
    create.mutate({
      projectKey: projectKey.trim(),
      assigneeAccountId: assigneeAccountId.trim(),
      matchKind,
      matchValue: matchValue.trim(),
      flowType,
      // "" is the "default agent" choice — normalised to null on the wire.
      analystVariantId: analystVariantId === "" ? null : analystVariantId,
      engineerVariantId: engineerVariantId === "" ? null : engineerVariantId,
    });
  };

  const columns: readonly Column<ListeningRule>[] = [
    { key: "projectKey", header: t("listening.col.project"), cell: (r) => <b className="screen-mono">{r.projectKey}</b> },
    {
      key: "trigger",
      header: t("listening.col.trigger"),
      cell: (r) => (
        <>
          <span className="screen-note">{t(`listening.match.${r.matchKind}`)}</span>{" "}
          <b>{r.matchValue}</b>
        </>
      ),
    },
    {
      key: "flowType",
      header: t("listening.col.flow"),
      cell: (r) => <Badge tone={FLOW_TONE[r.flowType]}>{t(`listening.flow.${r.flowType}`)}</Badge>,
    },
    {
      key: "agents",
      header: t("listening.col.agents"),
      // Which variant runs each side; an unset side reads "default", so a rule
      // that overrides nothing still says so instead of showing a blank cell.
      cell: (r) => (
        <span className="screen-note">
          {t("listening.agent.analyst_short")}:{" "}
          <b>{r.analystVariantId ?? t("listening.agent.default_short")}</b>
          {" · "}
          {t("listening.agent.engineer_short")}:{" "}
          <b>{r.engineerVariantId ?? t("listening.agent.default_short")}</b>
        </span>
      ),
    },
    {
      key: "assignee",
      header: t("listening.col.assignee"),
      // The raw accountId is a 40-char id that overruns the column and means
      // nothing to a reader; show a short, hoverable form.
      cell: (r) => (
        <span className="screen-mono screen-note" title={r.assigneeAccountId}>
          {shortAccount(r.assigneeAccountId)}
        </span>
      ),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      cell: (r) =>
        canWrite ? (
          <Button
            variant="danger"
            size="sm"
            busy={remove.isPending}
            onClick={() => remove.mutate(r.ruleId)}
          >
            {t("listening.action.delete")}
          </Button>
        ) : null,
    },
  ];

  return (
    <div className="screen-stack">
      <Card title={t("listening.title")} subtitle={t("listening.sub")}>
        <p className="screen-note">{t("listening.intro")}</p>
      </Card>

      {canWrite && (
        <Card title={t("listening.form.title")} subtitle={t("listening.form.sub")}>
          <div className="screen-filters">
            {boundProjects.length > 0 ? (
              <Select
                label={t("listening.form.project")}
                value={projectKey}
                onChange={(e) => setProjectKey(e.target.value)}
                options={[
                  { value: "", label: t("listening.form.project_choose") },
                  ...boundProjects.map((key) => ({ value: key, label: key })),
                ]}
                hint={t("listening.form.project_hint")}
              />
            ) : (
              // No bound projects yet: fall back to a text field rather than an
              // empty dropdown, so a rule can still be written, and say why.
              <Input
                label={t("listening.form.project")}
                value={projectKey}
                onChange={(e) => setProjectKey(e.target.value.trim().toUpperCase())}
                hint={t("listening.form.project_none_hint")}
              />
            )}
            <Input
              label={t("listening.form.assignee")}
              value={assigneeAccountId}
              onChange={(e) => {
                setAssigneeTouched(true);
                setAssigneeAccountId(e.target.value);
              }}
              placeholder="712020:…"
              hint={
                botAccountId
                  ? t("listening.form.assignee_hint_auto")
                  : t("listening.form.assignee_hint")
              }
            />
            <Select
              label={t("listening.form.matchKind")}
              value={matchKind}
              onChange={(e) => setMatchKind(e.target.value as MatchKind)}
              options={[
                { value: "issuetype", label: t("listening.match.issuetype") },
                { value: "status", label: t("listening.match.status") },
              ]}
            />
            {valueOptions.length > 0 ? (
              <Select
                label={t("listening.form.matchValue")}
                value={matchValue}
                onChange={(e) => setMatchValue(e.target.value)}
                options={[
                  { value: "", label: t("listening.form.matchValue_choose") },
                  ...valueOptions.map((v) => ({ value: v, label: v })),
                ]}
                hint={t("listening.form.matchValue_hint_auto")}
              />
            ) : (
              <Input
                label={t("listening.form.matchValue")}
                value={matchValue}
                onChange={(e) => setMatchValue(e.target.value)}
                placeholder={matchKind === "issuetype" ? "Hata" : "Analiz Bekliyor"}
                hint={t("listening.form.matchValue_hint")}
              />
            )}
            <Select
              label={t("listening.form.flow")}
              value={flowType}
              onChange={(e) => setFlowType(e.target.value as FlowType)}
              options={[
                { value: "analiz", label: t("listening.flow.analiz") },
                { value: "duzeltme", label: t("listening.flow.duzeltme") },
                { value: "gelistirme", label: t("listening.flow.gelistirme") },
              ]}
              hint={t(`listening.flow.hint.${flowType}`)}
            />
            <Select
              label={t("listening.agent.analyst")}
              value={analystVariantId}
              onChange={(e) => setAnalystVariantId(e.target.value)}
              options={[
                { value: "", label: t("listening.agent.default") },
                ...analystOptions.map((v) => ({ value: v.variantId, label: v.variantId })),
              ]}
              hint={t("listening.agent.hint")}
            />
            <Select
              label={t("listening.agent.engineer")}
              value={engineerVariantId}
              onChange={(e) => setEngineerVariantId(e.target.value)}
              options={[
                { value: "", label: t("listening.agent.default") },
                ...engineerOptions.map((v) => ({ value: v.variantId, label: v.variantId })),
              ]}
              hint={t("listening.agent.hint")}
            />
            <div style={{ display: "flex", alignItems: "flex-end" }}>
              <Button variant="primary" busy={create.isPending} onClick={onSubmit}>
                {t("listening.action.add")}
              </Button>
            </div>
          </div>
        </Card>
      )}

      <Card padded={false}>
        <QueryState
          isPending={query.isPending}
          error={query.error}
          onRetry={() => void query.refetch()}
          skeletonRows={3}
        >
          <Table
            columns={columns}
            rows={rules}
            rowKey={(r) => r.ruleId}
            emptyLabel={t("listening.empty")}
          />
        </QueryState>
      </Card>
    </div>
  );
}

/**
 * A Jira accountId is `<siteId>:<uuid>` — ~40 chars that blow out the column and
 * carry no meaning at a glance. Show the leading segment and an ellipsis; the
 * full value stays in the cell's `title` for anyone who needs to copy it.
 */
function shortAccount(accountId: string): string {
  if (accountId.length <= 14) return accountId;
  return `${accountId.slice(0, 12)}…`;
}
