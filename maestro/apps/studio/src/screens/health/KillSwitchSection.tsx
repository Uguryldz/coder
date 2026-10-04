import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ReactNode } from "react";
import { messageKeyOf } from "../../api/errors.ts";
import { useApi, useAuth } from "../../auth/AuthProvider.tsx";
import { useT } from "../../i18n/I18nProvider.tsx";
import { Badge, Button, Section, useToast } from "../../ui/index.ts";
import type { BadgeTone } from "../../ui/index.ts";
import {
  ConfirmModal,
  type KillSwitchLevel,
  type KillSwitchResult,
  type KillSwitchState,
  QueryState,
} from "../common/index.ts";
import { ageLabel } from "../shared/format.ts";

export const KILL_SWITCH_TONE: Readonly<Record<KillSwitchLevel, BadgeTone>> = {
  off: "green",
  intake_only: "amber",
  all: "red",
};

export const KILL_SWITCH_LEVEL_KEY: Readonly<Record<KillSwitchLevel, string>> = {
  off: "killswitch.level.off",
  intake_only: "killswitch.level.intake_only",
  all: "killswitch.level.all",
};

const ACTION_KEY: Readonly<Record<KillSwitchLevel, string>> = {
  off: "killswitch.action.resume",
  intake_only: "killswitch.action.pause_intake",
  all: "killswitch.action.stop_all",
};

/**
 * The two-level emergency stop (M58), on one line: the current level, who set
 * it and why, and the buttons that move it.
 *
 * Deliberately NOT a toggle: a switch is a control you flip by brushing it,
 * and this one halts a bank's delivery pipeline. Each level is a button that
 * opens a confirmation naming the exact consequence and refusing to submit
 * without a written reason — the same reason the BFF writes into the audit
 * chain. It is the ONLY place the switch is operated from: the `killswitch.state`
 * parameter the parameter screen lists has no reader.
 *
 * Fail closed on who may press: a non-admin or a delegated (AI-held) session
 * gets a sentence instead of a button that would 403. The BFF refuses both
 * anyway; showing a button that always fails teaches operators to ignore errors.
 */
export function KillSwitchSection(): ReactNode {
  const api = useApi();
  const t = useT();
  const toast = useToast();
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const [proposed, setProposed] = useState<KillSwitchLevel | null>(null);

  const state = useQuery({
    queryKey: ["killswitch"],
    queryFn: ({ signal }) => api.get<KillSwitchState>("/killswitch", { signal }),
  });

  const operate = useMutation({
    mutationFn: (input: { level: KillSwitchLevel; reason: string }) =>
      api.post<KillSwitchResult>("/killswitch", input),
    onSuccess: (result) => {
      setProposed(null);
      void queryClient.invalidateQueries({ queryKey: ["killswitch"] });
      toast.show(
        result.state.level === "off" ? "success" : "warning",
        t("killswitch.toast.applied", {
          level: t(KILL_SWITCH_LEVEL_KEY[result.state.level]),
          stopped: String(result.stopped.length),
        }),
      );
    },
    onError: (error) => toast.show("error", t(messageKeyOf(error))),
  });

  const isAdmin = session?.roles.includes("admin") ?? false;
  const delegated = session?.delegated ?? false;
  const mayOperate = isAdmin && !delegated;
  const level = state.data?.level;
  // A switch nobody has ever touched is reported with the store's sentinel
  // row (`KILL_SWITCH_OFF`: actor "maestro-worker", reason "initial", epoch
  // timestamp). Shown raw that reads "maestro-worker · initial · 20700 gün",
  // which an operator takes for a stuck 56-year-old intervention. The epoch
  // is the tell — no real change carries it — so the row says so instead.
  const neverUsed = state.data !== undefined && new Date(state.data.at).getTime() === 0;
  const at = neverUsed ? null : ageLabel(state.data?.at);

  return (
    <Section title={t("killswitch.card.title")} subtitle={t("killswitch.card.sub")}>
      <QueryState
        isPending={state.isPending}
        error={state.error}
        skeletonRows={1}
        onRetry={() => void state.refetch()}
      >
        {state.data !== undefined && level !== undefined && (
          <div className="scr-row">
            <Badge tone={KILL_SWITCH_TONE[level]} icon="●">
              {t(KILL_SWITCH_LEVEL_KEY[level])}
            </Badge>
            <span className="scr-mini" style={{ flex: 1, minWidth: 160 }}>
              {neverUsed ? (
                t("killswitch.never_used")
              ) : (
                <>
                  {state.data.actor}
                  {state.data.reason !== "" && <> · {state.data.reason}</>}
                  {at !== null && <> · {t(at.key, at.params)}</>}
                </>
              )}
            </span>
            {mayOperate ? (
              <span className="scr-row">
                {level === "off" && (
                  <Button size="sm" onClick={() => setProposed("intake_only")}>
                    {t("killswitch.action.pause_intake")}
                  </Button>
                )}
                {level !== "all" && (
                  <Button size="sm" variant="danger" onClick={() => setProposed("all")}>
                    {t("killswitch.action.stop_all")}
                  </Button>
                )}
                {level !== "off" && (
                  <Button size="sm" variant="primary" onClick={() => setProposed("off")}>
                    {t("killswitch.action.resume")}
                  </Button>
                )}
              </span>
            ) : (
              <span className="scr-mini">
                {delegated ? t("killswitch.note.delegated") : t("killswitch.note.admin_only")}
              </span>
            )}
          </div>
        )}
      </QueryState>

      <ConfirmModal
        open={proposed !== null}
        onClose={() => setProposed(null)}
        onConfirm={(reason) => {
          if (proposed !== null) operate.mutate({ level: proposed, reason });
        }}
        title={t("killswitch.confirm.title")}
        description={proposed === null ? "" : t(`killswitch.confirm.${proposed}`)}
        confirmLabel={proposed === null ? "" : t(ACTION_KEY[proposed])}
        destructive={proposed !== "off"}
        busy={operate.isPending}
      >
        <div className="scr-note scr-note--danger">{t("killswitch.confirm.audit_warning")}</div>
      </ConfirmModal>
    </Section>
  );
}
