import { useCallback } from "react";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import type { MessageParams } from "../../i18n/catalog.ts";

/**
 * Translate a key whose LAST segment comes from the server.
 *
 * `t()` throws on a missing key, which is the right default: a typo in a static
 * key should be loud. But several management screens build a key from server
 * data — `health.service.${id}`, `settings.connection.${id}`, `users.sod.${id}`
 * — and there the same rule is wrong twice over. A service the catalog has not
 * heard of yet would blank the entire health page behind the ErrorBoundary,
 * hiding the nine services that ARE known; and the unknown id is precisely the
 * new component an operator most needs to see.
 *
 * So: translate when the catalog knows the key, otherwise show the raw
 * identifier. The identifier is a machine id the BFF chose (`postgres`,
 * `jira_dc`), not server prose and not user input — the rule this project
 * actually protects is "never render a server SENTENCE", and an id in a label
 * column does not breach it.
 */
export function useLabel(): (key: string, fallback: string, params?: MessageParams) => string {
  const { t } = useI18n();

  return useCallback(
    (key: string, fallback: string, params?: MessageParams) => {
      try {
        return t(key, params);
      } catch {
        return fallback;
      }
    },
    [t],
  );
}

/** What {@link useEnumLabel} decided about one server value. */
export interface EnumLabel {
  /** Text to render. Translated when known; a marked raw value when not. */
  readonly text: string;
  /** True when the catalog had no entry — the caller should render it neutrally. */
  readonly unknown: boolean;
}

/**
 * The same idea as {@link useLabel}, for a CLOSED enum whose value arrives on
 * the wire — `role.${role}`, `sandbox.state.${state}`, `llm.role.${role}`.
 *
 * The trap this closes: `t()` throws on a missing key, the ErrorBoundary catches
 * the throw, and the WHOLE screen goes dark. One unrecognised row therefore
 * hides every recognised row beside it — a directory returning a single group
 * name outside the contract's six roles blanks the users screen entirely, and
 * the operator loses the answer to "is this account still privileged?".
 *
 * Failing dark is not failing safe here. The safe outcome is to keep the screen
 * up and make the unrecognised value VISIBLE, because an enum the catalog has
 * not heard of is exactly what an operator needs to notice: it means the server
 * and this build disagree about the vocabulary.
 *
 * `unknown: true` is returned rather than pre-styled text so the caller keeps
 * control of presentation — a badge that guessed a colour for an unknown state
 * would be inventing a meaning. Callers render it in a neutral tone.
 *
 * The raw value is safe to display: these are machine identifiers the server
 * chose from a fixed vocabulary (`archived`, `reviewer_x`), not server prose and
 * not user input. The rule this project protects is "never render a server
 * SENTENCE" — see `unknownValueText` for the prose case, which is different.
 */
export function useEnumLabel(): (keyPrefix: string, value: unknown) => EnumLabel {
  const { t } = useI18n();

  return useCallback(
    (keyPrefix: string, value: unknown) => {
      const raw = typeof value === "string" ? value : "";
      if (raw === "") return { text: t("value.unknown_blank"), unknown: true };
      try {
        return { text: t(`${keyPrefix}.${raw}`), unknown: false };
      } catch {
        // Bound the length so a server that sent something unexpected cannot
        // push a wall of text into a table cell.
        return { text: t("value.unrecognised", { value: raw.slice(0, 64) }), unknown: true };
      }
    },
    [t],
  );
}
