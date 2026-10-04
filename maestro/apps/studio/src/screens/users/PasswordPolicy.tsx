import type { ReactNode } from "react";
import { useT } from "../../i18n/I18nProvider.tsx";
import type { PasswordViolation } from "../common/index.ts";

/**
 * The password policy, as the two screens that meet it show it: the admin's
 * "add user" form and the person's own change-password page. One place for the
 * rule labels, so a rule the BFF adds is translated once.
 */

/** The failed-rule list from `password_policy.details`, defensively narrowed. */
export function readViolations(details: unknown): readonly PasswordViolation[] {
  if (typeof details !== "object" || details === null) return [];
  const value = (details as { violations?: unknown }).violations;
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is PasswordViolation => typeof entry === "string");
}

/** The failed password rules, one line each, in the operator's language. */
export function PasswordViolations({
  violations,
  className = "scr-note scr-note--danger",
}: {
  readonly violations: readonly PasswordViolation[];
  readonly className?: string;
}): ReactNode {
  const t = useT();
  if (violations.length === 0) return null;
  return (
    <div className={className} role="alert">
      <div>{t("login.password_policy_failed")}</div>
      <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
        {violations.map((rule) => (
          <li key={rule}>{t(`login.password_rule.${rule}`)}</li>
        ))}
      </ul>
    </div>
  );
}
