import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ReactNode } from "react";
import { messageKeyOf } from "../../api/errors.ts";
import { useApi } from "../../auth/AuthProvider.tsx";
import { useAuth } from "../../auth/AuthProvider.tsx";
import { hasRole } from "../../auth/types.ts";
import { useT } from "../../i18n/I18nProvider.tsx";
import { Badge, Button, Card, Input, Modal, Select, Table, useToast } from "../../ui/index.ts";
import type { BadgeTone, Column } from "../../ui/index.ts";
import type {
  ConnectionTestResponse,
  ManagedConnection,
  ManagedConnectionAuthKind,
  ManagedConnectionInput,
  ManagedConnectionKind,
} from "../common/index.ts";
import { ConfirmModal, QueryState } from "../common/index.ts";
import { ageLabel } from "../shared/format.ts";

/**
 * The connector-management section of the settings screen.
 *
 * The platform's outbound connections, made admin-editable: add a URL + token,
 * test it LIVE, and see the token only as a mask (****abcd). Everything a leak
 * would need is designed out — the token is write-only in the form, the API
 * never returns it, and the live test runs server-side against the STORED
 * credential. The whole section is admin-gated; a viewer never sees it.
 */

const KINDS: readonly ManagedConnectionKind[] = [
  "jira_cloud",
  "jira_dc",
  "github",
  "ado",
  "openrouter",
  "anthropic",
  "vault",
  "smtp",
  "storage",
];

const AUTH_KINDS: readonly ManagedConnectionAuthKind[] = ["basic", "bearer", "pat", "api_key"];

/**
 * The live-test result held per row so the screen can render it inline.
 *
 * `warn` marks a test that CONNECTED but found the stored bot account did not
 * belong to the token. It is not a failure and not a clean pass: the credential
 * works, yet anything keyed to the old account id — listening rules, four-eyes
 * exemptions, comment attribution — was pointing at the wrong person.
 */
type TestState = Readonly<Record<string, { ok: boolean; warn?: boolean; text: string } | "testing">>;

export function ConnectorsPanel(): ReactNode {
  const api = useApi();
  const t = useT();
  const { session } = useAuth();
  const isAdmin = hasRole(session, "admin");
  const [editing, setEditing] = useState<ManagedConnection | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<ManagedConnection | null>(null);
  const [tests, setTests] = useState<TestState>({});
  const toast = useToast();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["connections"],
    queryFn: ({ signal }) =>
      api.get<{ connections: readonly ManagedConnection[] }>("/studio/connections", { signal }),
  });

  const test = useMutation({
    mutationFn: (id: string) => api.post<ConnectionTestResponse>(`/studio/connections/${id}/test`),
    onMutate: (id) => setTests((prev) => ({ ...prev, [id]: "testing" })),
    onSuccess: (result, id) => {
      const text = t(result.messageKey, result.messageParams ?? {});
      const corrected = result.botAccountCorrected !== undefined;
      setTests((prev) => ({ ...prev, [id]: { ok: result.ok, warn: corrected, text } }));
      // A silently-fixed identity is exactly the thing an operator would miss in
      // a table cell, so it also gets a toast they have to dismiss.
      if (corrected) toast.show("error", text);
      void queryClient.invalidateQueries({ queryKey: ["connections"] });
    },
    onError: (error, id) => {
      setTests((prev) => ({ ...prev, [id]: { ok: false, text: t(messageKeyOf(error)) } }));
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete<void>(`/studio/connections/${id}`),
    onSuccess: (_void, id) => {
      void queryClient.invalidateQueries({ queryKey: ["connections"] });
      toast.show("success", t("connections.toast.deleted", { name: id }));
      setDeleting(null);
    },
    onError: (error) => toast.show("error", t(messageKeyOf(error))),
  });

  const columns: readonly Column<ManagedConnection>[] = [
    {
      key: "name",
      header: t("connections.col.name"),
      cell: (row) => (
        <div>
          <b>{row.displayName}</b>
          <div className="scr-mono scr-mini">{t(`connections.kind.${row.kind}`)}</div>
        </div>
      ),
    },
    {
      key: "status",
      header: t("connections.col.status"),
      cell: (row) => {
        const live = tests[row.id];
        if (live === "testing") return <Badge tone="gray">…</Badge>;
        // A just-run test wins the cell; otherwise the last recorded result.
        const ok = live !== undefined ? live.ok : row.lastTestOk;
        const { tone, icon, key } = statusOf(ok, live !== undefined && live.warn === true);
        // Under the badge: when the test was last run, and — on failure — WHY,
        // from the secret-free note. A just-run test shows its own text; the
        // stored note (a catalog key) is translated. Never a token/DSN.
        const age = ageLabel(row.lastTestedAt);
        // A corrected bot account reads out in full here too — the badge alone
        // cannot carry two 36-char ids, and "which id replaced which" is the
        // whole point of telling the operator.
        const failNote =
          live === undefined && row.lastTestOk === false && row.lastTestNote !== null
            ? t(row.lastTestNote)
            : live !== undefined && (!live.ok || live.warn === true)
              ? live.text
              : null;
        return (
          <div>
            <Badge tone={tone} icon={icon}>
              {live !== undefined ? live.text : t(key)}
            </Badge>
            {(age !== null || failNote !== null) && (
              <div className="scr-mini" style={{ marginTop: 3 }}>
                {age !== null && <span>{t(age.key, age.params)}</span>}
                {failNote !== null && (
                  <span style={{ color: "var(--red)" }}>
                    {age !== null ? " · " : ""}
                    {failNote}
                  </span>
                )}
              </div>
            )}
          </div>
        );
      },
    },
    {
      key: "url",
      header: t("connections.col.url"),
      cell: (row) => <span className="scr-mono scr-mini">{row.baseUrl}</span>,
    },
    {
      key: "token",
      header: t("connections.col.token"),
      cell: (row) =>
        row.secretSet ? (
          <span className="scr-mono scr-mini">{`****${row.secretMask ?? ""}`}</span>
        ) : (
          <span className="scr-mini">{t("connections.token.unset")}</span>
        ),
    },
    {
      key: "actions",
      header: "",
      cell: (row) =>
        isAdmin ? (
          <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
            <Button size="sm" busy={tests[row.id] === "testing"} onClick={() => test.mutate(row.id)}>
              🔌 {t("connections.action.test")}
            </Button>
            <Button size="sm" onClick={() => setEditing(row)}>
              {t("connections.action.edit")}
            </Button>
            <Button size="sm" variant="danger" onClick={() => setDeleting(row)}>
              {t("connections.action.delete")}
            </Button>
          </div>
        ) : null,
      align: "right",
    },
  ];

  return (
    <>
      <Card
        title={t("connections.card.title")}
        subtitle={t("connections.card.sub")}
        padded={false}
        actions={
          isAdmin ? (
            <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
              ➕ {t("connections.action.add")}
            </Button>
          ) : undefined
        }
      >
        <QueryState
          isPending={query.isPending}
          error={query.error}
          onRetry={() => void query.refetch()}
          skeletonRows={3}
        >
          <Table
            columns={columns}
            rows={query.data?.connections ?? []}
            rowKey={(row) => row.id}
            emptyLabel={t("connections.empty")}
            caption={t("connections.card.title")}
          />
        </QueryState>
      </Card>

      {creating && <ConnectionModal onClose={() => setCreating(false)} />}
      {editing !== null && (
        <ConnectionModal connection={editing} onClose={() => setEditing(null)} />
      )}
      {deleting !== null && (
        <ConfirmModal
          open
          onClose={() => setDeleting(null)}
          onConfirm={() => remove.mutate(deleting.id)}
          title={t("connections.action.delete")}
          description={t("connections.confirm.delete", { name: deleting.displayName })}
          confirmLabel={t("connections.action.delete")}
          destructive
          busy={remove.isPending}
        />
      )}
    </>
  );
}

/**
 * The badge tone/icon for a tri-state test result.
 *
 * `warn` overrides a pass with amber: the connection is genuinely up, but it
 * corrected a wrong bot account on the way, and a green tick would tell the
 * operator the opposite of what happened.
 */
function statusOf(ok: boolean | null, warn = false): { tone: BadgeTone; icon: string; key: string } {
  if (ok === null) return { tone: "gray", icon: "⚪", key: "connections.status.untested" };
  if (ok && warn) return { tone: "amber", icon: "⚠", key: "connections.status.ok_fixed" };
  return ok
    ? { tone: "green", icon: "●", key: "connections.status.ok" }
    : { tone: "red", icon: "✕", key: "connections.status.fail" };
}

/**
 * The add/edit modal.
 *
 * On edit, the token field starts LOCKED showing the mask — a "değiştir"
 * (change) button reveals an input. This is the whole point: the existing token
 * is never fetched to prefill (the API would refuse), and an untouched save
 * omits `token`, so the stored credential is preserved.
 */
function ConnectionModal({
  connection,
  onClose,
}: {
  readonly connection?: ManagedConnection;
  readonly onClose: () => void;
}): ReactNode {
  const api = useApi();
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const editing = connection !== undefined;

  const [id, setId] = useState(connection?.id ?? "");
  const [kind, setKind] = useState<ManagedConnectionKind>(connection?.kind ?? "jira_cloud");
  const [displayName, setDisplayName] = useState(connection?.displayName ?? "");
  const [baseUrl, setBaseUrl] = useState(connection?.baseUrl ?? "");
  const [authKind, setAuthKind] = useState<ManagedConnectionAuthKind>(connection?.authKind ?? "basic");
  const [enabled, setEnabled] = useState(connection?.enabled ?? true);
  // On edit with a token set, the field is locked until the admin chooses to change it.
  const [changingToken, setChangingToken] = useState(!editing || !(connection?.secretSet ?? false));
  const [token, setToken] = useState("");
  const [touched, setTouched] = useState(false);

  const idInvalid = !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id.trim());
  const urlInvalid = !isHttpUrl(baseUrl.trim());
  const blocked = (!editing && idInvalid) || urlInvalid || displayName.trim() === "";

  const save = useMutation({
    mutationFn: () => {
      const body: ManagedConnectionInput & { id?: string } = {
        kind,
        displayName: displayName.trim(),
        baseUrl: baseUrl.trim(),
        authKind,
        config: connection?.config ?? {},
        enabled,
        // Only send a token when the admin actually entered one — an untouched
        // edit preserves the stored credential.
        ...(changingToken && token !== "" ? { token } : {}),
      };
      return editing
        ? api.put<{ connection: ManagedConnection }>(`/studio/connections/${connection.id}`, body)
        : api.post<{ connection: ManagedConnection }>("/studio/connections", { ...body, id: id.trim() });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["connections"] });
      toast.show(
        "success",
        t(editing ? "connections.toast.updated" : "connections.toast.created", {
          name: displayName.trim() || id.trim(),
        }),
      );
      onClose();
    },
    onError: (error) => toast.show("error", t(messageKeyOf(error))),
  });

  const submit = (): void => {
    setTouched(true);
    if (blocked) return;
    save.mutate();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t(editing ? "connections.modal.edit_title" : "connections.modal.add_title")}
      closeLabel={t("action.close")}
      footer={
        <>
          <Button onClick={onClose}>{t("action.cancel")}</Button>
          <Button variant="primary" busy={save.isPending} onClick={submit}>
            {t(editing ? "connections.action.edit" : "connections.action.add")}
          </Button>
        </>
      }
    >
      {!editing && (
        <Input
          label={t("connections.field.id")}
          value={id}
          onChange={(event) => setId(event.target.value)}
          hint={t("connections.field.id_hint")}
          {...(touched && idInvalid ? { error: t("connections.error.id") } : {})}
        />
      )}
      <Select
        label={t("connections.field.kind")}
        value={kind}
        onChange={(event) => setKind(event.target.value as ManagedConnectionKind)}
        options={KINDS.map((option) => ({ value: option, label: t(`connections.kind.${option}`) }))}
      />
      <Input
        label={t("connections.field.name")}
        value={displayName}
        onChange={(event) => setDisplayName(event.target.value)}
      />
      <Input
        label={t("connections.field.url")}
        value={baseUrl}
        onChange={(event) => setBaseUrl(event.target.value)}
        {...(touched && urlInvalid ? { error: t("connections.error.url") } : {})}
      />
      <Select
        label={t("connections.field.auth")}
        value={authKind}
        onChange={(event) => setAuthKind(event.target.value as ManagedConnectionAuthKind)}
        options={AUTH_KINDS.map((option) => ({ value: option, label: t(`connections.auth.${option}`) }))}
      />
      <label className="scr-mini" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />
        {t("connections.field.enabled")}
      </label>
      {changingToken ? (
        <Input
          label={t("connections.field.token")}
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          hint={t("connections.field.token_hint")}
        />
      ) : (
        <div className="scr-mini" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="scr-mono">{`****${connection?.secretMask ?? ""}`}</span>
          <Button size="sm" onClick={() => setChangingToken(true)}>
            {t("connections.token.change")}
          </Button>
        </div>
      )}
    </Modal>
  );
}

/** A permissive http(s) URL check for the form — the BFF validates for real. */
function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
