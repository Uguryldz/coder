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
