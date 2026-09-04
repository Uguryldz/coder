import type { ParamChange, ParamDefinition } from "@maestro/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { messageKeyOf } from "../api/errors.ts";
import { useApi, useAuth } from "../auth/AuthProvider.tsx";
import { useI18n, useT } from "../i18n/I18nProvider.tsx";
import { Badge, Button, Card, Input, Table, useToast } from "../ui/index.ts";
import type { Column } from "../ui/index.ts";
import {
  formatValue,
  type ParamPutResult,
  type ParamsView,
  type PendingParamChange,
  QueryState,
} from "./common/index.ts";
import { useLabel } from "./common/label.ts";
import { ParamEditor } from "./params/ParamEditor.tsx";
import { dateTimeLabel } from "./shared/format.ts";

interface Row {
  readonly definition: ParamDefinition;
  readonly value: unknown;
  readonly version: number;
  readonly changedBy: string | null;
  readonly at: string | null;
  readonly pending: PendingParamChange | null;
}

/**
 * Parameters that have a screen of their own and are NOT listed here. Each is
 * edited in one place only: two doors onto the same row is how an operator
 * changes it on one screen and reads a stale value on the other.
 *
 *  · `escalation.ladder`, `notify.routing`, `notify.teams.webhook` — Bildirim
 *  · `killswitch.state` — Bağlantılar (the kill-switch panel)
 */
const OWNED_ELSEWHERE: ReadonlySet<string> = new Set([
  "escalation.ladder",
  "notify.routing",
  "notify.teams.webhook",
  "killswitch.state",
]);

/**
 * The groups the flat list is folded into, by key prefix, in reading order.
 * A key whose prefix matches nothing lands in `other` — a new parameter is
 * shown, never hidden, until somebody files it.
 */
const GROUPS: readonly { readonly id: string; readonly prefixes: readonly string[] }[] = [
  { id: "jira", prefixes: ["jira."] },
  { id: "gates", prefixes: ["gates.", "sod.", "scan.", "merge.", "stuck.", "dataclass."] },
  { id: "workspace", prefixes: ["workspace.", "build.", "coverage."] },
  { id: "ai", prefixes: ["lang.", "quota.", "subscription."] },
  { id: "binding", prefixes: ["binding.", "publish."] },
  { id: "notify", prefixes: ["notify.", "escalation."] },
];

function groupOf(key: string): string {
  return GROUPS.find((group) => group.prefixes.some((prefix) => key.startsWith(prefix)))?.id ?? "other";
}

/**
 * Operational parameters: the gate sets, the SoD switches, the Jira polling
 * cadence — the settings that used to live in five repositories' YAML.
 *
 * The screen's job beyond listing is to make four-eyes VISIBLE. A `guarded`
 * key carries a badge in the table, a warning in the editor and — once
 * proposed — a row that names the proposer and states the old value is still
 * the live one. The BFF is what enforces it (`putParam`); this is what stops an
 * operator believing a policy changed when it is only queued.
 *
 * Only the GLOBAL value of each parameter is shown and edited here. A
 * project-scoped definition's global row is the default every project starts
 * from; the editor says so instead of a "scope" column that could only ever
 * read "global".
 */
export function ParamsScreen(): ReactNode {
  const api = useApi();
  const { session } = useAuth();
  const t = useT();
  const { locale } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const label = useLabel();
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const params = useQuery({
    queryKey: ["params"],
    queryFn: ({ signal }) => api.get<ParamsView>("/params", { signal }),
  });

  const save = useMutation({
    mutationFn: (input: { key: string; value: unknown }) =>
      api.put<ParamPutResult>(`/params/${encodeURIComponent(input.key)}`, {
        value: input.value,
        scopeRef: null,
      }),
    onSuccess: (result, input) => {
      setEditingKey(null);
      void queryClient.invalidateQueries({ queryKey: ["params"] });
      toast.show(
        result.status === "applied" ? "success" : "warning",
        result.status === "applied"
          ? t("params.toast.applied", { key: input.key })
          : t("params.toast.pending", { key: input.key }),
      );
    },
    onError: (error) => toast.show("error", t(messageKeyOf(error))),
  });

  const rows = useMemo<readonly Row[]>(() => buildRows(params.data), [params.data]);
  const editing = rows.find((row) => row.definition.key === editingKey) ?? null;

  const visible = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase("tr");
    return rows.filter((row) => {
      const key = row.definition.key;
      if (needle === "") return true;
      const description = label(row.definition.descriptionKey, "").toLocaleLowerCase("tr");
      return key.toLocaleLowerCase("tr").includes(needle) || description.includes(needle);
    });
  }, [rows, search, label]);

  const grouped = useMemo(() => {
    const byGroup = new Map<string, Row[]>();
    for (const row of visible) {
      const id = groupOf(row.definition.key);
      const bucket = byGroup.get(id);
      if (bucket === undefined) byGroup.set(id, [row]);
      else bucket.push(row);
    }
    const order = [...GROUPS.map((group) => group.id), "other"];
    return order
      .filter((id) => byGroup.has(id))
      .map((id) => ({ id, rows: byGroup.get(id) ?? [] }));
  }, [visible]);

  const columns: readonly Column<Row>[] = [
    {
      key: "key",
      header: t("params.col.key"),
      cell: (row) => (
        <div>
          <code className="scr-mono">{row.definition.key}</code>
          {row.definition.guarded && (
            <>
              {" "}
              <Badge tone="amber">{t("params.badge.guarded")}</Badge>
            </>
          )}
          <div className="scr-mini">{label(row.definition.descriptionKey, row.definition.key)}</div>
        </div>
      ),
    },
    {
      key: "value",
      header: t("params.col.value"),
      cell: (row) => (
        <div>
          <span className="scr-mono">{shortValue(row.value)}</span>
          {row.pending !== null && (
            <div className="scr-mini">
              <Badge tone="orange">{t("params.badge.awaiting_approval")}</Badge>{" "}
              {t("params.pending.summary", {
                by: row.pending.proposedBy,
                value: shortValue(row.pending.value),
              })}
            </div>
          )}
        </div>
      ),
    },
    {
      key: "changed",
      header: t("params.col.last_change"),
      cell: (row) =>
        row.version === 0 ? (
          <span className="scr-mini">{t("params.value.default")}</span>
        ) : (
          <div className="scr-mini">
            <span className="scr-mono">v{row.version}</span>
            {row.changedBy !== null && <> · {row.changedBy}</>}
            {row.at !== null && <div>{dateTimeLabel(row.at, locale)}</div>}
          </div>
        ),
    },
    {
      key: "edit",
      header: "",
      align: "right",
      cell: (row) => (
        <Button size="sm" onClick={() => setEditingKey(row.definition.key)}>
          {row.definition.guarded ? t("params.action.review") : t("params.action.edit")}
        </Button>
      ),
    },
  ];

  return (
    <div className="scr-stack">
      <Card title={t("params.card.list")} subtitle={t("params.card.list_sub")} padded={false}>
        <div style={{ padding: "10px 14px 0" }}>
          <Input
            label={t("params.search.label")}
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("params.search.placeholder")}
          />
        </div>
        <QueryState
          isPending={params.isPending}
          error={params.error}
          onRetry={() => void params.refetch()}
        >
          {grouped.length === 0 ? (
            <p className="scr-mini" style={{ padding: "12px 14px" }}>
              {search.trim() === "" ? t("params.empty") : t("params.search.empty")}
            </p>
          ) : (
            grouped.map((group) => (
              <section key={group.id}>
                <h3 className="scr-mini" style={{ margin: "14px 14px 4px", textTransform: "uppercase" }}>
                  {t(`params.group.${group.id}`)}
                </h3>
                <Table
                  columns={columns}
                  rows={group.rows}
                  rowKey={(row) => row.definition.key}
                  emptyLabel={t("params.empty")}
                  caption={t(`params.group.${group.id}`)}
                />
              </section>
            ))
          )}
        </QueryState>
        <p className="scr-hint" style={{ margin: "10px 14px 12px" }}>
          {t("params.note.owned_elsewhere")}{" "}
          <Link to="/notify">{t("params.note.owned_elsewhere_notify")}</Link>
          {" · "}
          <Link to="/settings">{t("params.note.owned_elsewhere_killswitch")}</Link>
        </p>
      </Card>

      <p className="scr-hint">{t("params.note.why_db")}</p>

      {editing !== null && (
        <ParamEditor
          definition={editing.definition}
          currentValue={editing.value}
          currentVersion={editing.version}
          pending={editing.pending}
          viewerUserId={session?.userId ?? null}
          busy={save.isPending}
          onClose={() => setEditingKey(null)}
          onSubmit={(value) => save.mutate({ key: editing.definition.key, value })}
        />
      )}
    </div>
  );
}

/** A table cell must not become a paragraph: long JSON is cut, the editor shows it whole. */
function shortValue(value: unknown): string {
  const text = formatValue(value);
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}

/**
 * `values` is an append-only history: one ParamChange per version. The current
 * value is the highest version for the key, and a definition with no change at
 * all is still shown — sitting on its default is a fact the operator needs, and
 * hiding unset parameters would make the list look shorter than the policy is.
 */
function buildRows(view: ParamsView | undefined): readonly Row[] {
  if (view === undefined) return [];

  const latest = new Map<string, ParamChange>();
  for (const change of view.values) {
    if (change.scopeRef !== null) continue;
    const current = latest.get(change.key);
    if (current === undefined || change.version > current.version) latest.set(change.key, change);
  }

  return view.definitions
    .filter((definition) => !OWNED_ELSEWHERE.has(definition.key))
    .map((definition) => {
      const change = latest.get(definition.key);
      const pending =
        view.pending.find((item) => item.key === definition.key && item.scopeRef === null) ?? null;
      return {
        definition,
        value: change?.value ?? definition.defaultValue,
        version: change?.version ?? 0,
        changedBy: change?.changedBy ?? null,
        at: change?.at ?? null,
        pending,
      };
    });
}
