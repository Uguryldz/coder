import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { useApi } from "../auth/AuthProvider.tsx";
import { useT } from "../i18n/I18nProvider.tsx";
import type { KillSwitchLevel, KillSwitchState } from "../screens/common/admin-api.ts";
import { Badge } from "../ui/Badge.tsx";

const TONE = {
  off: "green",
  intake_only: "amber",
  all: "red",
} as const;

const LABEL_KEY: Readonly<Record<KillSwitchLevel, string>> = {
  off: "killswitch.level.off",
  intake_only: "killswitch.level.intake_only",
  all: "killswitch.level.all",
};

/**
 * Global pause indicator in the top bar. GET /killswitch needs a session but no
 * role, so every signed-in operator sees the platform state. Polled rather than
 * pushed: there is no event stream from the BFF today. It links to the health
 * screen, which is the one place the switch is operated from.
 */
export function KillSwitchIndicator(): ReactNode {
  const api = useApi();
  const t = useT();

  const { data, isPending, isError } = useQuery({
    queryKey: ["killswitch"],
    queryFn: ({ signal }) => api.get<KillSwitchState>("/killswitch", { signal }),
    refetchInterval: 30_000,
  });

  if (isPending || isError || data === undefined) return null;

  return (
    <Link to="/health" title={t("killswitch.indicator.open")} style={{ textDecoration: "none" }}>
      <Badge tone={TONE[data.level]} icon="●">
        {t(LABEL_KEY[data.level])}
      </Badge>
    </Link>
  );
}
