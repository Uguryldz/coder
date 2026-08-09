import { ROLES, type Role } from "@maestro/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ReactNode } from "react";
import { messageKeyOf } from "../api/errors.ts";
import { useApi, useAuth } from "../auth/AuthProvider.tsx";
import { useT } from "../i18n/I18nProvider.tsx";
import { Badge, Button, Card, Table, useToast } from "../ui/index.ts";
import type { BadgeTone, Column } from "../ui/index.ts";
import {
  ConfirmModal,
  KeyValue,
  type ManagedUser,
  QueryState,
  type SodRule,
  type UsersView,
} from "./common/index.ts";
import { useLabel } from "./common/label.ts";
import { RoleEditor } from "./users/RoleEditor.tsx";

const ROLE_TONE: Readonly<Record<Role, BadgeTone>> = {
  admin: "purple",
  "tech-lead": "blue",
  "product-owner": "teal",
  qa: "orange",
  developer: "green",
  viewer: "gray",
};

/**
 * Accounts and roles. Identity comes from the directory; authority is granted
 * here from the CLOSED role set in `contracts` (`ROLES`) — never typed as free
 * text, because a menu filtered on `tech-leads` when the session says
 * `tech-lead` renders an empty sidebar and reads as a permissions outage.
 *
 * Revocation is the reason this screen is careful. An earlier build let a
 * disabled account keep an eight-hour bearer while the table showed it as
 * revoked; the fix is that `activeSessions` is displayed next to `active`, so
 * "disabled but still holding N live sessions" is a state the operator can SEE
 * rather than one the UI paints over.
 */
export function UsersScreen(): ReactNode {
  const api = useApi();
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const label = useLabel();
  const { session } = useAuth();
  const [editing, setEditing] = useState<ManagedUser | null>(null);
  const [deactivating, setDeactivating] = useState<ManagedUser | null>(null);

  const users = useQuery({
    queryKey: ["users"],
    queryFn: ({ signal }) => api.get<UsersView>("/users", { signal }),
  });

  const setRoles = useMutation({
    mutationFn: (input: { userId: string; roles: readonly Role[] }) =>
      api.put<ManagedUser>(`/users/${encodeURIComponent(input.userId)}/roles`, {
        roles: input.roles,
      }),
    onSuccess: (_result, input) => {
      setEditing(null);
      void queryClient.invalidateQueries({ queryKey: ["users"] });
      toast.show("success", t("users.toast.roles_saved", { user: input.userId }));
    },
    onError: (error) => toast.show("error", t(messageKeyOf(error))),
  });

  const setActive = useMutation({
    mutationFn: (input: { userId: string; active: boolean; reason: string }) =>
      api.put<ManagedUser>(`/users/${encodeURIComponent(input.userId)}/active`, {
        active: input.active,
        reason: input.reason,
      }),
    onSuccess: (result, input) => {
      setDeactivating(null);
      void queryClient.invalidateQueries({ queryKey: ["users"] });
      // Naming the surviving session count is the whole point: revoking the
      // account and killing its tokens are two different things, and the
      // operator must not assume the second happened because the first did.
      toast.show(
        result.activeSessions > 0 ? "warning" : "success",
        result.activeSessions > 0
          ? t("users.toast.deactivated_sessions_live", {
              user: input.userId,
              sessions: String(result.activeSessions),
            })
          : t("users.toast.deactivated", { user: input.userId }),
      );
    },
    onError: (error) => toast.show("error", t(messageKeyOf(error))),
  });

  const isAdmin = session?.roles.includes("admin") ?? false;
  const delegated = session?.delegated ?? false;
  const mayEdit = isAdmin && !delegated;

  const columns: readonly Column<ManagedUser>[] = [
    {
      key: "user",
      header: t("users.col.user"),
      cell: (row) => (
        <div>
          <b>{row.displayName}</b>
          <div className="scr-mono scr-mini">{row.userId}</div>
        </div>
      ),
    },
    {
      key: "groups",
      header: t("users.col.groups"),
      cell: (row) => <span className="scr-mono scr-mini">{row.groups.join(", ") || "—"}</span>,
    },
    {
      key: "roles",
      header: t("users.col.roles"),
      cell: (row) => (
        <span className="scr-row">
          {row.roles.map((role) => (
            <Badge key={role} tone={ROLE_TONE[role]}>
              {t(`role.${role}`)}
            </Badge>
          ))}
        </span>
      ),
    },
    {
      key: "state",
      header: t("users.col.state"),
      cell: (row) =>
        row.active ? (
          <Badge tone="green">{t("users.state.active")}</Badge>
        ) : (
          <div>
            <Badge tone="red">{t("users.state.disabled")}</Badge>
            {row.activeSessions > 0 && (
              <div className="scr-mini">
                {t("users.warning.sessions_live", { sessions: String(row.activeSessions) })}
              </div>
            )}
          </div>
        ),
    },
    {
      key: "actions",
      header: t("users.col.actions"),
      cell: (row) =>
        mayEdit ? (
          <span className="scr-row">
            <Button size="sm" onClick={() => setEditing(row)}>
              {t("users.action.edit_roles")}
            </Button>
            {row.active && (
              <Button size="sm" variant="danger" onClick={() => setDeactivating(row)}>
                {t("users.action.deactivate")}
              </Button>
            )}
          </span>
        ) : (
          <span className="scr-mini">{t("users.action.read_only")}</span>
        ),
    },
  ];

  const sodColumns: readonly Column<SodRule>[] = [
    {
      key: "rule",
      header: t("users.col.sod_rule"),
      cell: (row) => label(`users.sod.${row.id}`, row.id),
    },
    {
      key: "enforced",
      header: t("users.col.sod_state"),
      cell: (row) => (
        <Badge tone={row.enforced ? "green" : "amber"}>
          {t(row.enforced ? "users.sod.enforced" : "users.sod.optional")}
        </Badge>
      ),
    },
  ];

  const serviceAccount = users.data?.serviceAccount ?? null;

  return (
    <div className="scr-stack">
      <QueryState
        isPending={users.isPending}
        error={users.error}
        onRetry={() => void users.refetch()}
      >
        <Card title={t("users.card.list")} subtitle={t("users.card.list_sub")} padded={false}>
          <Table
            columns={columns}
            rows={users.data?.users ?? []}
            rowKey={(row) => row.userId}
            emptyLabel={t("users.empty")}
            caption={t("users.card.list")}
          />
        </Card>

        <div className="scr-grid scr-grid--2">
          <Card title={t("users.card.sod")} padded={false}>
            <Table
              columns={sodColumns}
              rows={users.data?.sod ?? []}
              rowKey={(row) => row.id}
              emptyLabel={t("users.empty.sod")}
              caption={t("users.card.sod")}
            />
          </Card>

          <Card title={t("users.card.service_account")}>
            {serviceAccount === null ? (
              <p className="scr-mini">{t("users.empty.service_account")}</p>
            ) : (
              <>
                <KeyValue
                  entries={[
                    {
                      label: t("users.field.account"),
                      value: <span className="scr-mono">{serviceAccount.account}</span>,
                    },
                    { label: t("users.field.jira"), value: serviceAccount.jira },
                    { label: t("users.field.ado"), value: serviceAccount.ado },
                    {
                      label: t("users.field.commit_signature"),
                      value: <span className="scr-mono">{serviceAccount.commitSignature}</span>,
                    },
                    {
                      label: t("users.field.credential_ttl"),
                      value: t("users.value.minutes", {
                        minutes: String(serviceAccount.credentialTtlMinutes),
                      }),
                    },
                  ]}
                />
                <div className="scr-note" style={{ marginTop: 11 }}>
                  {t("users.note.ai_cannot_approve")}
                </div>
              </>
            )}
          </Card>
        </div>
      </QueryState>

      {editing !== null && (
        <RoleEditor
          user={editing}
          roles={ROLES}
          busy={setRoles.isPending}
          onClose={() => setEditing(null)}
          onSubmit={(roles) => setRoles.mutate({ userId: editing.userId, roles })}
        />
      )}

      <ConfirmModal
        open={deactivating !== null}
        onClose={() => setDeactivating(null)}
        onConfirm={(reason) => {
          if (deactivating !== null) {
            setActive.mutate({ userId: deactivating.userId, active: false, reason });
          }
        }}
        title={t("users.confirm.deactivate_title")}
        description={
          deactivating === null
            ? ""
            : t("users.confirm.deactivate_desc", { user: deactivating.displayName })
        }
        confirmLabel={t("users.action.deactivate")}
        destructive
        busy={setActive.isPending}
      >
        {deactivating !== null && deactivating.activeSessions > 0 && (
          <div className="scr-note scr-note--warn">
            {t("users.confirm.sessions_warning", {
              sessions: String(deactivating.activeSessions),
            })}
          </div>
        )}
      </ConfirmModal>
    </div>
  );
}
