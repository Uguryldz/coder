import type { ReactNode } from "react";
import { useT } from "../../i18n/I18nProvider.tsx";
import { Badge, runStatusTone } from "../../ui/index.ts";
import { useEnumLabel } from "../common/label.ts";
import type { RunStatus } from "./runs.ts";
import { RUN_STATUS_PREFIX } from "../tickets/status.ts";

/**
 * A status badge that tells "not started" apart from a status. Shared by the
 * Panel list, the run detail sidebar and the fan-out tree, so the same status
 * is the same word and colour everywhere.
 *
 * `null` is rendered as "unknown" rather than as any status: the run exists in
 * the catalog and the workflow engine has never heard of it, and picking
 * "queued" for that would invent a queue position nothing assigned.
 */
export function RunStatusCell({ status }: { readonly status: RunStatus | null }): ReactNode {
  const t = useT();
  const enumLabel = useEnumLabel();
  if (status === null) return <span className="scr-hint">{t("run.status.unknown")}</span>;
  return <Badge tone={runStatusTone(status)}>{enumLabel(RUN_STATUS_PREFIX, status).text}</Badge>;
}
