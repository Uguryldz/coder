import { ROLES, type Role } from "@maestro/contracts";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { ReactNode } from "react";
import { useApi } from "../auth/AuthProvider.tsx";
import { useT } from "../i18n/I18nProvider.tsx";
import { Badge, Button, Card, Input } from "../ui/index.ts";
import type { BadgeTone } from "../ui/index.ts";
import type { DirectoryUser } from "./common/index.ts";
import { KeyValue, QueryState } from "./common/index.ts";

const ROLE_TONE: Readonly<Record<Role, BadgeTone>> = {
  admin: "purple",
  "tech-lead": "blue",
  "product-owner": "teal",
  qa: "orange",
  developer: "green",
  viewer: "gray",
};

/**
 * Separation-of-duty rules (M32/M92) as the platform enforces them. Static
 * because they are properties of the workflow engine rather than per-deployment
 * configuration — `canDecideGate` in contracts is the same fact expressed in
 * code.
 */
const SOD_RULES = [
  "producer_approver",
  "po_tl",
  "approver_merger",
  "ai_cannot_approve",
  "qa_split",
] as const;

/**
 * Who holds which role (M8/M86).
 *
 * This is a LOOKUP, not a management table, and the difference is the whole
 * design. The BFF exposes exactly one route — `GET /studio/users/:username` —
 * because the directory is the source of truth for identity and authority:
 * roles come from AD group membership, and Maestro reads that mapping rather
 * than owning it.
 *
 * So there is no role editor and no deactivate button here. Building either
 * would mean calling endpoints that do not exist, and — worse — implying that
 * revoking an account in Studio revokes it everywhere. Revocation happens in
 * the directory. What this screen can honestly do is tell an operator what the
 * platform currently believes about an account, including when it believes the
 * account is disabled, and warn that a disabled account's issued tokens live
 * until they expire.
 */
export function UsersScreen(): ReactNode {
  const api = useApi();
  const t = useT();
  const [draft, setDraft] = useState("");
  const [username, setUsername] = useState<string | null>(null);

  const user = useQuery({
    queryKey: ["studio-user", username],
    queryFn: ({ signal }) =>
      api.get<DirectoryUser>(`/studio/users/${encodeURIComponent(username ?? "")}`, { signal }),
    // No lookup until a name has been submitted: an empty query would 404 on
    // every keystroke and train the operator to ignore the error.
    enabled: username !== null,
  });

  const submit = (): void => {
    const trimmed = draft.trim();
    if (trimmed !== "") setUsername(trimmed);
  };

  return (
    <div className="scr-stack">
      <Card title={t("users.card.lookup")} subtitle={t("users.card.lookup_sub")}>
        <form
          className="scr-row"
          style={{ alignItems: "flex-end" }}
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <Input
            label={t("users.field.username")}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            hint={t("users.field.username_hint")}
          />
          <Button type="submit" variant="primary">
            {t("users.action.lookup")}
          </Button>
        </form>
      </Card>

      {username !== null && (
        <QueryState
          isPending={user.isPending}
          error={user.error}
          onRetry={() => void user.refetch()}
          skeletonRows={3}
        >
          {user.data !== undefined && <UserCard user={user.data} />}
        </QueryState>
      )}

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
        <div className="scr-note" style={{ marginTop: 12 }}>
          {t("users.note.directory_owns_roles")}
        </div>
      </Card>

      <Card title={t("users.card.sod")} subtitle={t("users.card.sod_sub")}>
        <ul className="scr-stack" style={{ gap: 7, margin: 0, paddingLeft: 18 }}>
          {SOD_RULES.map((rule) => (
            <li key={rule} className="scr-prose" style={{ margin: 0 }}>
              {t(`users.sod.${rule}`)}
            </li>
          ))}
        </ul>
        <div className="scr-note" style={{ marginTop: 12 }}>
          {t("users.note.ai_cannot_approve")}
        </div>
      </Card>
    </div>
  );
}

function UserCard({ user }: { readonly user: DirectoryUser }): ReactNode {
  const t = useT();

  return (
    <Card
      title={user.username}
      actions={
        user.active ? (
          <Badge tone="green">{t("users.state.active")}</Badge>
        ) : (
          <Badge tone="red">{t("users.state.disabled")}</Badge>
        )
      }
    >
      <KeyValue
        entries={[
          {
            label: t("users.field.account"),
            value: <span className="scr-mono">{user.userId}</span>,
          },
          {
            label: t("users.col.groups"),
            value: (
              <span className="scr-mono scr-mini">
                {user.groups.join(", ") || t("users.value.none")}
              </span>
            ),
          },
          {
            label: t("users.col.roles"),
            value: (
              <span className="scr-row">
                {user.roles.length === 0 ? (
                  <span className="scr-mini">{t("users.value.none")}</span>
                ) : (
                  user.roles.map((role) => (
                    <Badge key={role} tone={ROLE_TONE[role]}>
                      {t(`role.${role}`)}
                    </Badge>
                  ))
                )}
              </span>
            ),
          },
        ]}
      />

      {!user.active && (
        <div className="scr-note scr-note--warn" style={{ marginTop: 12 }}>
          {t("users.note.disabled_sessions")}
        </div>
      )}
    </Card>
  );
}
