import { ROLES, type Role } from "@maestro/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { ApiError, messageKeyOf } from "../api/errors.ts";
import { useApi } from "../auth/AuthProvider.tsx";
import { useT } from "../i18n/I18nProvider.tsx";
import { Badge, Button, Card, Input, Modal, Table, useToast } from "../ui/index.ts";
import type { BadgeTone, Column } from "../ui/index.ts";
import { ASSIGNABLE_GROUPS, ROLE_BY_GROUP } from "./common/index.ts";
import type {
  CreateUserRequest,
  DirectoryUser,
  EditUserRequest,
  PasswordViolation,
  UsersView,
} from "./common/index.ts";
import { ConfirmModal, QueryState, useEnumLabel } from "./common/index.ts";
import { PasswordViolations, readViolations } from "./users/PasswordPolicy.tsx";

const ROLE_TONE: Readonly<Record<Role, BadgeTone>> = {
  admin: "purple",
  "tech-lead": "blue",
  "product-owner": "teal",
  qa: "orange",
  developer: "green",
  viewer: "gray",
};

/**
 * The tone for a role that arrived on the wire.
 *
 * `roles` is typed `readonly string[]` because the directory owns group names
 * and may carry one outside the contract's six roles. A missing tone must not
 * become `undefined` (an unstyled badge) or borrow a known role's colour (an
 * authority the platform never granted). Neutral grey is the honest answer.
 */
function roleTone(role: string): BadgeTone {
  return Object.hasOwn(ROLE_TONE, role) ? ROLE_TONE[role as Role] : "gray";
}

/**
 * Separation-of-duty rules as the platform enforces them. Static because they
 * are properties of the workflow engine — `canDecideGate` in contracts is the
 * same fact in code.
 */
const SOD_RULES = [
  "producer_approver",
  "po_tl",
  "approver_merger",
  "qa_split",
  "ai_cannot_approve",
] as const;

/** `POST /studio/users/:username/reset-password` — the one-time answer. */
interface ResetPasswordResult {
  readonly user: DirectoryUser;
  readonly temporaryPassword: string;
  readonly killedSessions: number;
}

type Dialog =
  | { readonly kind: "form"; readonly editing: DirectoryUser | null }
  | { readonly kind: "deactivate"; readonly user: DirectoryUser }
  | { readonly kind: "reactivate"; readonly user: DirectoryUser }
  | { readonly kind: "reset"; readonly user: DirectoryUser };

/**
 * User administration.
 *
 * Admin-only, and a real management surface: the directory is still the source
 * of truth for AUTHORITY — roles are derived from group membership, never typed
 * in — but the platform's local accounts are created, edited, off-boarded,
 * reactivated and re-keyed here. Off-boarding DEACTIVATES rather than deletes:
 * a departed approver's name is on closed gates, so the row survives its
 * revocation. A password reset hands the admin a temporary password exactly
 * once; the account has to change it at its next login.
 */
export function UsersScreen(): ReactNode {
  const api = useApi();
  const t = useT();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [search, setSearch] = useState("");

  const users = useQuery({
    queryKey: ["studio-users"],
    queryFn: ({ signal }) => api.get<UsersView>("/studio/users", { signal }),
  });

  const all = users.data?.items ?? [];
  const rows = useMemo(() => filterUsers(all, search), [all, search]);
  const close = (): void => setDialog(null);

  const columns: readonly Column<DirectoryUser>[] = [
    {
      key: "username",
      header: t("users.col.username"),
      // The readable name leads and the username follows it. For a person the
      // two are usually the same string; for the Jira bot the heading becomes
      // "maestro (Jira bot)" instead of the slug `jira-bot-maestro`.
      cell: (row) => {
        // `?? username`: an older BFF may not send the field, and rendering
        // `undefined` as the heading would read as a broken account.
        const name = row.displayName ?? row.username;
        return (
          <div>
            <b>{name}</b>
            <div className="scr-mono scr-mini">
              {name === row.username ? row.userId : `${row.username} · ${row.userId}`}
            </div>
          </div>
        );
      },
    },
    {
      key: "groups",
      header: t("users.col.groups"),
      cell: (row) => (
        <span className="scr-mono scr-mini">
          {row.groups.join(", ") || t("users.value.none")}
        </span>
      ),
    },
    {
      key: "roles",
      header: t("users.col.roles"),
      cell: (row) => <RoleBadges user={row} />,
    },
    {
      key: "state",
      header: t("users.col.state"),
      cell: (row) =>
        row.active ? (
          <Badge tone="green">{t("users.state.active")}</Badge>
        ) : (
          <Badge tone="red">{t("users.state.disabled")}</Badge>
        ),
    },
    {
      key: "actions",
      header: "",
      cell: (row) => (
        <span className="scr-row" style={{ gap: 6, justifyContent: "flex-end", flexWrap: "wrap" }}>
          <Button size="sm" onClick={() => setDialog({ kind: "form", editing: row })}>
            {t("users.action.edit")}
          </Button>
          {row.active ? (
            <>
              <Button size="sm" onClick={() => setDialog({ kind: "reset", user: row })}>
                {t("users.action.reset_password")}
              </Button>
              <Button size="sm" variant="danger" onClick={() => setDialog({ kind: "deactivate", user: row })}>
                {t("users.action.deactivate")}
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={() => setDialog({ kind: "reactivate", user: row })}>
              {t("users.action.reactivate")}
            </Button>
          )}
        </span>
      ),
    },
  ];

  return (
    <div className="scr-stack">
      <Card
        title={t("users.card.list")}
        subtitle={t("users.card.list_sub")}
        padded={false}
        actions={
          <Button variant="primary" size="sm" onClick={() => setDialog({ kind: "form", editing: null })}>
            {t("users.action.add")}
          </Button>
        }
      >
        <div style={{ padding: "10px 14px 0" }}>
          <Input
            label={t("users.search.label")}
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("users.search.placeholder")}
          />
        </div>
        <QueryState
          isPending={users.isPending}
          error={users.error}
          onRetry={() => void users.refetch()}
          skeletonRows={4}
        >
          <Table
            columns={columns}
            rows={rows}
            rowKey={(row) => row.username}
            emptyLabel={search.trim() === "" ? t("users.empty") : t("users.search.empty")}
            caption={t("users.card.list")}
          />
        </QueryState>
      </Card>

      <Card title={t("users.card.roles")} subtitle={t("users.card.roles_sub")}>
        <dl className="scr-kv">
          {ROLES.map((role) => (
            <div key={role} style={{ display: "contents" }}>
              <dt>
                <Badge tone={ROLE_TONE[role]}>{t(`role.${role}`)}</Badge>
              </dt>
              <dd>{t(`role.${role}.desc`)}</dd>
            </div>
          ))}
        </dl>
        <p className="scr-hint" style={{ marginTop: 10 }}>{t("users.note.directory_owns_roles")}</p>
      </Card>

      <Card title={t("users.card.sod")} subtitle={t("users.card.sod_sub")}>
        <ul className="scr-stack" style={{ gap: 6, margin: 0, paddingLeft: 18 }}>
          {SOD_RULES.map((rule) => (
            <li key={rule} className="scr-prose" style={{ margin: 0 }}>
              {t(`users.sod.${rule}`)}
            </li>
          ))}
        </ul>
      </Card>

      {dialog?.kind === "form" && (
        <UserFormModal editing={dialog.editing} onClose={close} onSaved={close} />
      )}
      {dialog?.kind === "deactivate" && <DeactivateModal user={dialog.user} onClose={close} />}
      {dialog?.kind === "reactivate" && <ReactivateModal user={dialog.user} onClose={close} />}
      {dialog?.kind === "reset" && <ResetPasswordModal user={dialog.user} onClose={close} />}
    </div>
  );
}

/** Case-insensitive match on the name, the login, the actor id and the groups. */
function filterUsers(items: readonly DirectoryUser[], query: string): readonly DirectoryUser[] {
  const needle = query.trim().toLocaleLowerCase("tr");
  if (needle === "") return items;
  return items.filter((user) =>
    [user.username, user.displayName ?? "", user.userId, ...user.groups, ...user.roles].some(
      (field) => field.toLocaleLowerCase("tr").includes(needle),
    ),
  );
}

function RoleBadges({ user }: { readonly user: DirectoryUser }): ReactNode {
  const t = useT();
  const enumLabel = useEnumLabel();

  if (user.roles.length === 0) return <span className="scr-mini">{t("users.value.none")}</span>;

  return (
    <span className="scr-row" style={{ gap: 6, flexWrap: "wrap" }}>
      {user.roles.map((role) => {
        const label = enumLabel("role", role);
        // A disabled account's roles are struck through and muted — a purple
        // `admin` badge in its normal register would say "still privileged",
        // the opposite of what a revocation means.
        const tone = label.unknown || !user.active ? "gray" : roleTone(role);
        return (
          <Badge key={role} tone={tone}>
            {user.active ? (
              label.text
            ) : (
              <s title={t("users.note.role_not_in_force")}>{label.text}</s>
            )}
          </Badge>
        );
      })}
    </span>
  );
}

/**
 * Create or edit. One modal for both: the only difference is the username and
 * password fields, which an edit hides — the password is never re-keyed as a
 * side effect of editing groups (that is "reset password", a separate act),
 * and the username of an existing account is its identity and cannot move.
 */
function UserFormModal({
  editing,
  onClose,
  onSaved,
}: {
  readonly editing: DirectoryUser | null;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}): ReactNode {
  const api = useApi();
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const isEdit = editing !== null;

  const [username, setUsername] = useState(editing?.username ?? "");
  const [displayName, setDisplayName] = useState(editing?.displayName ?? editing?.username ?? "");
  const [password, setPassword] = useState("");
  const [groups, setGroups] = useState<readonly string[]>(editing?.groups ?? []);
  const [violations, setViolations] = useState<readonly PasswordViolation[]>([]);
  const [touched, setTouched] = useState(false);

  const save = useMutation({
    mutationFn: (): Promise<DirectoryUser> => {
      if (isEdit) {
        const body: EditUserRequest = { displayName: displayName.trim(), groups };
        return api.put<DirectoryUser>(
          `/studio/users/${encodeURIComponent(editing.username)}`,
          body,
        );
      }
      const body: CreateUserRequest = {
        username: username.trim(),
        displayName: displayName.trim(),
        groups,
        password,
      };
      return api.post<DirectoryUser>("/studio/users", body);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["studio-users"] });
      toast.show("success", t(isEdit ? "users.toast.edited" : "users.toast.created"));
      onSaved();
    },
    onError: (error) => {
      // A weak password comes back with the exact rules it broke — show them
      // inline against the field rather than as a single opaque toast.
      if (error instanceof ApiError && error.code === "password_policy") {
        setViolations(readViolations(error.details));
        return;
      }
      toast.show("error", t(messageKeyOf(error)));
    },
  });

  const toggleGroup = (group: string): void => {
    setGroups((current) =>
      current.includes(group) ? current.filter((g) => g !== group) : [...current, group],
    );
  };

  const nameInvalid = username.trim() === "";
  const displayInvalid = displayName.trim() === "";
  const passwordInvalid = !isEdit && password === "";
  const blocked = (!isEdit && (nameInvalid || passwordInvalid)) || displayInvalid;

  const submit = (): void => {
    setTouched(true);
    setViolations([]);
    if (blocked) return;
    save.mutate();
  };

  // The derived roles preview, so an admin sees what the groups they picked will
  // grant BEFORE saving — the same reading the BFF does server-side.
  const previewRoles = derivePreviewRoles(groups);

  return (
    <Modal
      open
      onClose={onClose}
      title={t(isEdit ? "users.modal.edit_title" : "users.modal.add_title")}
      closeLabel={t("action.close")}
      footer={
        <>
          <Button onClick={onClose}>{t("action.cancel")}</Button>
          <Button variant="primary" busy={save.isPending} onClick={submit}>
            {t(isEdit ? "users.action.save" : "users.action.add")}
          </Button>
        </>
      }
    >
      {!isEdit && (
        <Input
          label={t("users.field.username")}
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          hint={t("users.field.username_hint")}
          {...(touched && nameInvalid ? { error: t("users.error.username_required") } : {})}
        />
      )}

      <Input
        label={t("users.field.display_name")}
        value={displayName}
        onChange={(event) => setDisplayName(event.target.value)}
        {...(touched && displayInvalid ? { error: t("users.error.display_required") } : {})}
      />

      {!isEdit && (
        <Input
          label={t("users.field.password")}
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          hint={t("login.password_hint")}
          {...(touched && passwordInvalid ? { error: t("users.error.password_required") } : {})}
        />
      )}

      <div style={{ marginTop: 8 }}>
        <PasswordViolations violations={violations} />
      </div>

      <fieldset className="scr-fieldset" style={{ marginTop: 12 }}>
        <legend className="ui-field__label">{t("users.field.groups")}</legend>
        <div className="scr-mini" style={{ marginBottom: 8 }}>{t("users.field.groups_hint")}</div>
        <div className="scr-checklist">
          {ASSIGNABLE_GROUPS.map((group) => {
            const role = ROLE_BY_GROUP[group] ?? "viewer";
            return (
              <label key={group} className="scr-check" style={{ alignItems: "flex-start" }}>
                <input
                  type="checkbox"
                  checked={groups.includes(group)}
                  onChange={() => toggleGroup(group)}
                />
                <span style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                  <span className="scr-row" style={{ gap: 6, alignItems: "center" }}>
                    <b>{t(`users.group.${group}.name`)}</b>
                    <Badge tone={roleTone(role)}>{t(`role.${role}`)}</Badge>
                    <span className="scr-mono scr-mini">{group}</span>
                  </span>
                  <span className="scr-mini">{t(`users.group.${group}.desc`)}</span>
                </span>
              </label>
            );
          })}
        </div>
        <div className="scr-mini" style={{ marginTop: 8 }}>
          {t("users.field.roles_preview")}:{" "}
          {previewRoles.map((role) => t(`role.${role}`)).join(", ")}
        </div>
      </fieldset>
    </Modal>
  );
}

/**
 * A yes/no confirmation for the REVERSIBLE user actions (reactivate, reset).
 * Deliberately not `ConfirmModal` for those: it demands a written reason, and
 * a reason field whose text nobody asked for is noise. Off-boarding is the
 * exception — see `DeactivateModal`.
 */
function PlainConfirm({
  title,
  description,
  confirmLabel,
  destructive = false,
  busy,
  onConfirm,
  onClose,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
  readonly destructive?: boolean;
  readonly busy: boolean;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
  readonly children?: ReactNode;
}): ReactNode {
  const t = useT();
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      closeLabel={t("action.close")}
      footer={
        <>
          <Button onClick={onClose}>{t("action.cancel")}</Button>
          <Button variant={destructive ? "danger" : "primary"} busy={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="scr-prose">{description}</p>
      {children}
    </Modal>
  );
}

function DeactivateModal({
  user,
  onClose,
}: {
  readonly user: DirectoryUser;
  readonly onClose: () => void;
}): ReactNode {
  const api = useApi();
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();

  const deactivate = useMutation({
    mutationFn: (reason: string) =>
      api.delete<DirectoryUser>(`/studio/users/${encodeURIComponent(user.username)}`, {
        query: { reason },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["studio-users"] });
      toast.show("warning", t("users.toast.deactivated", { username: user.username }));
      onClose();
    },
    onError: (error) => toast.show("error", t(messageKeyOf(error))),
  });

  // Off-boarding revokes a person's access and is written to the audit trail,
  // so it takes a mandatory reason like every other destructive act on the
  // platform (bank audit: WHO was removed is not enough, WHY must be on file).
  // The reason travels with the request so the BFF can record it.
  return (
    <ConfirmModal
      open
      onClose={onClose}
      onConfirm={(reason) => deactivate.mutate(reason)}
      title={t("users.confirm.deactivate_title")}
      description={t("users.confirm.deactivate_desc", { username: user.username })}
      confirmLabel={t("users.action.deactivate")}
      destructive
      busy={deactivate.isPending}
    >
      <div className="scr-note scr-note--warn">{t("users.confirm.deactivate_warning")}</div>
    </ConfirmModal>
  );
}

/** Reactivation is `PUT { active: true }` — the reverse of off-boarding, with roles back in force. */
function ReactivateModal({
  user,
  onClose,
}: {
  readonly user: DirectoryUser;
  readonly onClose: () => void;
}): ReactNode {
  const api = useApi();
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();

  const reactivate = useMutation({
    mutationFn: () => {
      const body: EditUserRequest = { active: true };
      return api.put<DirectoryUser>(`/studio/users/${encodeURIComponent(user.username)}`, body);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["studio-users"] });
      toast.show("success", t("users.toast.reactivated", { username: user.username }));
      onClose();
    },
    onError: (error) => toast.show("error", t(messageKeyOf(error))),
  });

  return (
    <PlainConfirm
      title={t("users.confirm.reactivate_title")}
      description={t("users.confirm.reactivate_desc", { username: user.username })}
      confirmLabel={t("users.action.reactivate")}
      busy={reactivate.isPending}
      onConfirm={() => reactivate.mutate()}
      onClose={onClose}
    />
  );
}

/**
 * Two screens in one modal: the confirmation, then — once the BFF answers — the
 * temporary password, shown exactly once. It is never fetched again, so the
 * modal refuses to close by accident: the only way out is the explicit button,
 * after the admin has copied or read the value.
 */
function ResetPasswordModal({
  user,
  onClose,
}: {
  readonly user: DirectoryUser;
  readonly onClose: () => void;
}): ReactNode {
  const api = useApi();
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [copied, setCopied] = useState(false);

  const reset = useMutation({
    mutationFn: () =>
      api.post<ResetPasswordResult>(
        `/studio/users/${encodeURIComponent(user.username)}/reset-password`,
        {},
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["studio-users"] });
    },
    onError: (error) => toast.show("error", t(messageKeyOf(error))),
  });

  const result = reset.data;

  if (result === undefined) {
    return (
      <PlainConfirm
        title={t("users.confirm.reset_title")}
        description={t("users.confirm.reset_desc", { username: user.username })}
        confirmLabel={t("users.action.reset_password")}
        busy={reset.isPending}
        onConfirm={() => reset.mutate()}
        onClose={onClose}
      >
        <div className="scr-note scr-note--warn">{t("users.confirm.reset_warning")}</div>
      </PlainConfirm>
    );
  }

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(result.temporaryPassword);
      setCopied(true);
    } catch {
      // No clipboard (insecure context, permissions) — the value is on screen.
      setCopied(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t("users.reset.done_title")}
      closeLabel={t("action.close")}
      footer={
        <Button variant="primary" onClick={onClose}>
          {t("users.reset.done_close")}
        </Button>
      }
    >
      <p className="scr-prose">{t("users.reset.done_body", { username: user.username })}</p>
      <div className="scr-row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <code className="scr-mono" style={{ fontSize: 16, userSelect: "all" }} data-testid="temporary-password">
          {result.temporaryPassword}
        </code>
        <Button size="sm" onClick={() => void copy()}>
          {copied ? t("users.reset.copied") : t("users.reset.copy")}
        </Button>
      </div>
      <p className="scr-hint" style={{ marginTop: 10 }}>
        {t("users.reset.done_note", { sessions: String(result.killedSessions) })}
      </p>
    </Modal>
  );
}

/** Roles the given groups grant, mirroring the BFF's `rolesOf` for the preview. */
function derivePreviewRoles(groups: readonly string[]): readonly Role[] {
  const roles = new Set<Role>(["viewer"]);
  for (const group of groups) {
    const role = ROLE_BY_GROUP[group];
    if (role !== undefined) roles.add(role);
  }
  return [...roles];
}
