import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ReactNode } from "react";
import { messageKeyOf } from "../../api/errors.ts";
import { useApi, useAuth } from "../../auth/AuthProvider.tsx";
import { hasRole } from "../../auth/types.ts";
import { useT } from "../../i18n/I18nProvider.tsx";
import { Badge, Button, ListRow, Section, useToast } from "../../ui/index.ts";
import type { BadgeTone } from "../../ui/index.ts";
import type { ConnectionTestResponse, ManagedConnection, ManagedConnectionKind } from "../common/index.ts";
import { ConfirmModal, QueryState } from "../common/index.ts";
import { ageLabel } from "../shared/format.ts";
import { ConnectionForm } from "./ConnectionForm.tsx";
import { FAMILIES, familyOf, isProbeless } from "./connection-kinds.ts";

/**
 * Bağlantılar — the platform's outbound connections, one line each.
 *
 * Grouped by family (issue tracker / model / code repository / infrastructure),
 * and each connection is a single {@link ListRow}: status badge from the LAST
 * TEST · name · kind · the facts that used to be invisible (default model,
 * on-prem, disabled, token mask, when it was last tested, why it failed) ·
 * test / edit / delete. No cards, no table of five columns.
 *
 * The token is never here: the API returns a four-character mask and a flag,
 * the live test runs server-side against the STORED credential, and the whole
 * write surface is admin-only — a tech-lead reads the list, a viewer never
 * reaches the screen.
 */

/**
 * The live-test result held per row so it can be rendered inline. `warn`
 * marks a test that connected but corrected a wrong bot account on the way —
 * the credential works, yet every rule keyed to the old id was pointing at
 * the wrong person, so it is amber, not green.
 */
type TestState = Readonly<Record<string, { ok: boolean; warn: boolean; text: string } | "testing">>;

export function ConnectorsPanel(): ReactNode {
  const api = useApi();
  const t = useT();
  const { session } = useAuth();
  const isAdmin = hasRole(session, "admin");
  const [editing, setEditing] = useState<ManagedConnection | null>(null);
  const [creating, setCreating] = useState<{ kind?: ManagedConnectionKind } | null>(null);
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
      const warn = result.botAccountCorrected !== undefined;
      setTests((prev) => ({ ...prev, [id]: { ok: result.ok, warn, text } }));
      // A silently-fixed identity is exactly what an operator would miss in a
      // row's small print, so it also gets a toast they have to dismiss.
      if (warn) toast.show("error", text);
      void queryClient.invalidateQueries({ queryKey: ["connections"] });
    },
    onError: (error, id) => {
      setTests((prev) => ({ ...prev, [id]: { ok: false, warn: false, text: t(messageKeyOf(error)) } }));
    },
  });

  const remove = useMutation({
    mutationFn: (input: { id: string; reason: string }) =>
      // The reason rides to the BFF and into the audit row — the confirmation
      // promises as much, and for a long time that promise was empty.
      api.delete<void>(`/studio/connections/${input.id}`, { query: { reason: input.reason } }),
    onSuccess: (_void, input) => {
      void queryClient.invalidateQueries({ queryKey: ["connections"] });
      toast.show("success", t("connections.toast.deleted", { name: deleting?.displayName ?? input.id }));
      setDeleting(null);
    },
    onError: (error) => toast.show("error", t(messageKeyOf(error))),
  });

  const rows = query.data?.connections ?? [];

  return (
    <div className="scr-stack">
      <div className="scr-row">
        <p className="scr-mini" style={{ flex: 1, margin: 0 }}>
          {t("connections.intro")}
        </p>
        {isAdmin && (
          <Button variant="primary" size="sm" onClick={() => setCreating({})}>
            {t("connections.action.add")}
          </Button>
        )}
      </div>

      <QueryState
        isPending={query.isPending}
        error={query.error}
        onRetry={() => void query.refetch()}
        skeletonRows={4}
      >
        {FAMILIES.map((family) => {
          const inFamily = rows.filter((row) => familyOf(row.kind) === family);
          return (
            <Section
              key={family}
              title={t(`connections.family.${family}`)}
              subtitle={t(`connections.family.${family}_sub`)}
            >
              {inFamily.length === 0 ? (
                <p className="scr-hint" style={{ margin: 0 }}>
                  {t("connections.empty_family")}
                </p>
              ) : (
                <div className="ui-list">
                  {inFamily.map((row) => (
                    <ConnectionRow
                      key={row.id}
                      row={row}
                      live={tests[row.id]}
                      admin={isAdmin}
                      onTest={() => test.mutate(row.id)}
                      onEdit={() => setEditing(row)}
                      onDelete={() => setDeleting(row)}
                    />
                  ))}
                </div>
              )}
            </Section>
          );
        })}
      </QueryState>

      {creating !== null && (
        <ConnectionForm
          {...(creating.kind === undefined ? {} : { initialKind: creating.kind })}
          onClose={() => setCreating(null)}
        />
      )}
      {editing !== null && <ConnectionForm connection={editing} onClose={() => setEditing(null)} />}
      {deleting !== null && (
        <ConfirmModal
          open
          onClose={() => setDeleting(null)}
          onConfirm={(reason) => remove.mutate({ id: deleting.id, reason })}
          title={t("connections.action.delete")}
          description={t("connections.confirm.delete", { name: deleting.displayName })}
          confirmLabel={t("connections.action.delete")}
          destructive
          busy={remove.isPending}
        >
          <p className="scr-hint">{t("connections.confirm.delete_audit")}</p>
        </ConfirmModal>
      )}
    </div>
  );
}

/**
 * One connection on one line. The status badge answers "does it work?" from
 * the last test (a just-run test wins over the stored verdict); the small
 * print under the name carries everything else an operator used to have to
 * open the edit dialog to learn.
 */
function ConnectionRow({
  row,
  live,
  admin,
  onTest,
  onEdit,
  onDelete,
}: {
  readonly row: ManagedConnection;
  readonly live: TestState[string] | undefined;
  readonly admin: boolean;
  readonly onTest: () => void;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
}): ReactNode {
  const t = useT();
  const probeless = isProbeless(row.kind);
  const testing = live === "testing";
  const status = statusOf(row, live);
  const age = ageLabel(row.lastTestedAt);

  // The sentence under the row: a just-run test's own text, or the stored
  // secret-free note of a failed test (a catalog key, possibly with params).
  const note =
    live !== undefined && live !== "testing"
      ? live.text
      : row.lastTestOk === false && row.lastTestNote !== null
        ? renderNote(t, row.lastTestNote)
        : null;
  const noteTone = live !== undefined && live !== "testing" && live.ok && !live.warn ? "ok" : "bad";

  return (
    <ListRow
      status={
        <Badge tone={status.tone} icon={status.icon}>
          {testing ? "…" : t(status.key)}
        </Badge>
      }
      title={row.displayName}
      kind={t(`connections.kind.${row.kind}`)}
      meta={
        <>
          <span className="scr-mono">{row.baseUrl}</span>
          {row.isDefault && <Badge tone="blue">{t("connections.meta.default")}</Badge>}
          {row.onPrem && <Badge tone="gray">{t("connections.meta.on_prem")}</Badge>}
          <span className="scr-mono">
            {row.secretSet ? `****${row.secretMask ?? ""}` : t("connections.token.unset")}
          </span>
          {probeless ? (
            <span>{t("connections.meta.no_live_test")}</span>
          ) : age !== null ? (
            <span>{t("connections.meta.last_test", { age: t(age.key, age.params) })}</span>
          ) : null}
          {note !== null && (
            <span style={{ color: noteTone === "ok" ? "var(--muted)" : "var(--red)", flexBasis: "100%" }}>
              {note}
            </span>
          )}
        </>
      }
      actions={
        admin ? (
          <>
            {!probeless && (
              <Button size="sm" busy={testing} onClick={onTest}>
                {t("connections.action.test")}
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={onEdit}>
              {t("connections.action.edit")}
            </Button>
            <Button size="sm" variant="ghost" onClick={onDelete}>
              {t("connections.action.delete")}
            </Button>
          </>
        ) : undefined
      }
    />
  );
}

/**
 * The badge for a row, in precedence order: disabled beats everything (a row
 * nobody dials has no live status worth reading); a just-run test beats the
 * stored verdict; a kind with no probe says so instead of "not tested"; and
 * `warn` overrides a pass with amber.
 */
function statusOf(
  row: ManagedConnection,
  live: TestState[string] | undefined,
): { tone: BadgeTone; icon: string; key: string } {
  if (!row.enabled) return { tone: "gray", icon: "○", key: "connections.status.disabled" };
  const ok = live !== undefined && live !== "testing" ? live.ok : row.lastTestOk;
  const warn = live !== undefined && live !== "testing" && live.warn;
  if (ok === null) {
    return isProbeless(row.kind)
      ? { tone: "gray", icon: "○", key: "connections.status.untestable" }
      : { tone: "gray", icon: "⚪", key: "connections.status.untested" };
  }
  if (ok && warn) return { tone: "amber", icon: "⚠", key: "connections.status.ok_fixed" };
  return ok
    ? { tone: "green", icon: "●", key: "connections.status.ok" }
    : { tone: "red", icon: "✕", key: "connections.status.fail" };
}

/**
 * Render a STORED test note, which carries its params with it as
 * `key?host=...` (see `noteWithParams` in the BFF). Rendering the key alone
 * left the operator reading a literal `{host}` after every reload.
 */
function renderNote(t: ReturnType<typeof useT>, note: string): string {
  const split = note.indexOf("?");
  if (split === -1) return t(note);
  const params: Record<string, string> = {};
  for (const [name, value] of new URLSearchParams(note.slice(split + 1))) params[name] = value;
  return t(note.slice(0, split), params);
}
