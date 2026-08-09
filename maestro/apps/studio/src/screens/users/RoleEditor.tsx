import type { Role } from "@maestro/contracts";
import { useState } from "react";
import type { ReactNode } from "react";
import { useT } from "../../i18n/I18nProvider.tsx";
import { Button, Modal } from "../../ui/index.ts";
import { KeyValue, type ManagedUser } from "../common/index.ts";

export interface RoleEditorProps {
  readonly user: ManagedUser;
  /** The closed role set from contracts — never a free-text field. */
  readonly roles: readonly Role[];
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onSubmit: (roles: readonly Role[]) => void;
}

/**
 * Granting roles is a set of checkboxes over `ROLES`, not a text field. The
 * closed set is the point: `contracts/identity.ts` records that `tech-lead`,
 * `tech-leads`, `tl` and `yonetici` were once all in the tree naming the same
 * authority, and a free-text control is how that happens again.
 *
 * `viewer` is the floor, not an empty list. Clearing every box submits
 * `["viewer"]`, so an account whose roles are wiped becomes read-only rather
 * than role-less — the failure mode of an unbounded account is worse than the
 * failure mode of a blind one.
 */
export function RoleEditor({ user, roles, busy, onClose, onSubmit }: RoleEditorProps): ReactNode {
  const t = useT();
  const [selected, setSelected] = useState<readonly Role[]>(user.roles);

  const toggle = (role: Role): void => {
    setSelected((current) =>
      current.includes(role) ? current.filter((item) => item !== role) : [...current, role],
    );
  };

  const effective: readonly Role[] = selected.length === 0 ? ["viewer"] : selected;

  return (
    <Modal
      open
      onClose={onClose}
      title={t("users.edit.title")}
      closeLabel={t("action.close")}
      footer={
        <>
          <Button onClick={onClose}>{t("action.cancel")}</Button>
          <Button variant="primary" busy={busy} onClick={() => onSubmit(effective)}>
            {t("action.save")}
          </Button>
        </>
      }
    >
      <KeyValue
        entries={[
          { label: t("users.col.user"), value: user.displayName },
          { label: t("users.field.account"), value: <span className="scr-mono">{user.userId}</span> },
          {
            label: t("users.col.groups"),
            value: <span className="scr-mono scr-mini">{user.groups.join(", ") || "—"}</span>,
          },
        ]}
      />

      <fieldset style={{ border: 0, margin: "12px 0 0", padding: 0 }}>
        <legend className="scr-mini">{t("users.edit.legend")}</legend>
        {roles.map((role) => (
          <label key={role} className="scr-toggle-row" htmlFor={`role-${role}`}>
            <input
              id={`role-${role}`}
              type="checkbox"
              checked={selected.includes(role)}
              onChange={() => toggle(role)}
            />
            <span className="scr-toggle-row__text">
              <span className="scr-toggle-row__title">{t(`role.${role}`)}</span>
              <span className="scr-mini">{t(`role.${role}.desc`)}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {selected.length === 0 && (
        <div className="scr-note scr-note--warn">{t("users.edit.viewer_floor")}</div>
      )}
      <div className="scr-note">{t("users.edit.audit_note")}</div>
    </Modal>
  );
}
