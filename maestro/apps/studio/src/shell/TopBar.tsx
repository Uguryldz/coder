import type { ReactNode } from "react";
import { useAuth } from "../auth/AuthProvider.tsx";
import { useI18n, useT } from "../i18n/I18nProvider.tsx";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { useLabel } from "../screens/common/label.ts";
import { KillSwitchIndicator } from "./KillSwitchIndicator.tsx";

export interface TopBarProps {
  /** Already-translated page heading for the current route. */
  readonly title: string;
  readonly navOpen?: boolean;
  /** Present when the sidebar is a drawer (narrow screens). */
  readonly onToggleNav?: () => void;
}

/**
 * Heading, kill-switch state, user + role, language. The role is shown beside
 * the user name because the menu is filtered by it: an operator who cannot
 * find "Kullanıcılar" should be able to see WHY without asking.
 */
export function TopBar({ title, navOpen = false, onToggleNav }: TopBarProps): ReactNode {
  const t = useT();
  const label = useLabel();
  const { locale, setLocale } = useI18n();
  const { session, logout } = useAuth();

  // Show the strongest role; the rest are listed in the tooltip.
  const roles = session?.roles ?? [];
  const primaryRole = roles[0];
  const roleText = roles.map((role) => label(`role.${role}`, role)).join(", ");

  return (
    <header className="shell__top">
      {onToggleNav !== undefined && (
        <button
          type="button"
          className="shell__burger"
          aria-label={navOpen ? t("shell.menu_close") : t("shell.menu_open")}
          aria-expanded={navOpen}
          onClick={onToggleNav}
        >
          ☰
        </button>
      )}
      <h1>{title}</h1>
      <div className="shell__spacer" />

      <KillSwitchIndicator />

      {session?.delegated === true && <Badge tone="purple">{t("shell.delegated")}</Badge>}

      <select
        className="shell__lang"
        aria-label={t("shell.language")}
        value={locale}
        onChange={(event) => setLocale(event.target.value === "en" ? "en" : "tr")}
      >
        <option value="tr">{t("locale.tr")}</option>
        <option value="en">{t("locale.en")}</option>
      </select>

      {session !== null && (
        <span className="shell__user" title={`${t("shell.role_label")}: ${roleText}`}>
          {session.username}
          {primaryRole !== undefined && (
            <span className="shell__role">{label(`role.${primaryRole}`, primaryRole)}</span>
          )}
        </span>
      )}

      <Button size="sm" onClick={() => void logout()}>
        {t("shell.logout")}
      </Button>
    </header>
  );
}
