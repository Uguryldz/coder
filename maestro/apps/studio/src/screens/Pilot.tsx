import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { messageKeyOf } from "../api/errors.ts";
import { useApi, useAuth } from "../auth/AuthProvider.tsx";
import { hasAnyRole } from "../auth/types.ts";
import { useT } from "../i18n/I18nProvider.tsx";
import { Badge, Button, Card, Table, useToast } from "../ui/index.ts";
import type { BadgeTone, Column } from "../ui/index.ts";
import { QueryState } from "./shared/QueryState.tsx";
import "./shared/screens.css";

/**
 * Screen: pilot — the pilot's REAL-Jira flow, driven from Studio (Dalga D).
 *
 * The pilot (apps/pilot, :7020) is the flow engine: it discovers a `maestro`
 * OPS ticket on the live Jira site, runs the analysis/code/scan/test/PR flow,
 * and opens two human gates the operator answers with `/approve` in the REAL
 * ticket. This screen is its FACE — the operator never leaves Studio. Every
 * call goes through the BFF proxy (`/studio/pilot/*`), which forwards to the
 * pilot; the pilot's own page keeps working, this is an additional door.
 *
 * WHY POLL, NOT EventSource. The pilot streams state over SSE and the BFF
 * passes it through (`/studio/pilot/events`), but the browser's `EventSource`
 * cannot attach the Studio bearer, and the proxy authenticates every request.
 * So this screen POLLS `/studio/pilot/state` on a short interval — the same
 * live picture, over a channel that carries the session token. The SSE
 * passthrough stays available for a future auth-carrying client.
 *
 * The roles gate is on the START button, not the screen: a viewer may WATCH the
 * flow (state/events are open to any session) but not start it or change
 * settings — those are refused at the BFF for anyone below operator, and the
 * button is hidden so a viewer is not handed one that only 403s.
 */

/** Poll while the tab is open; a run at a gate is the one worth watching live. */
export const PILOT_REFRESH_MS = 4_000;

/** The pilot's operator roles, mirrored from the BFF `PILOT_WRITE_ROLES`. */
const PILOT_WRITE_ROLES = ["admin", "tech-lead"] as const;

type StepState = "bekliyor" | "calisiyor" | "onay" | "tamam" | "hata";

interface DiscoveredTicket {
  readonly key: string;
  readonly summary: string;
  readonly status: string | null;
  readonly createdAt: string | null;
}

interface PilotStep {
  readonly id: string;
  readonly title: string;
  readonly hint: string;
  readonly state: StepState;
  readonly notes: readonly string[];
}

/** Mirrors apps/pilot/src/state.ts `PilotState` — only the fields this screen reads. */
interface PilotStateWire {
  readonly runId: string | null;
  readonly ticketKey: string | null;
  readonly browseUrl: string | null;
  readonly jiraSite: string;
  readonly approverGroup: string;
  readonly running: boolean;
  readonly finished: boolean;
  readonly failure: string | null;
  readonly awaitingGate: string | null;
  readonly docsReady: boolean;
  readonly discovered: readonly DiscoveredTicket[];
  readonly steps: readonly PilotStep[];
}

const STEP_TONE: Readonly<Record<StepState, BadgeTone>> = {
  bekliyor: "gray",
  calisiyor: "blue",
  onay: "amber",
  tamam: "green",
  hata: "red",
};

export function PilotScreen(): ReactNode {
  const t = useT();
  const api = useApi();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const canStart = hasAnyRole(session, PILOT_WRITE_ROLES);

  const query = useQuery({
    queryKey: ["pilot-state"],
    queryFn: ({ signal }) => api.get<PilotStateWire>("/studio/pilot/state", { signal }),
    refetchInterval: PILOT_REFRESH_MS,
    retry: false,
  });

  const start = useMutation({
    mutationFn: (ticketKey: string) =>
      api.post<{ ok: boolean }>("/studio/pilot/start", { ticketKey }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["pilot-state"] });
      toast.show("success", t("pilot.toast.started"));
    },
    onError: (error) => toast.show("error", t(messageKeyOf(error))),
  });

  const state = query.data;
  const running = state?.running ?? false;
  const gateStep = state?.awaitingGate ?? null;

  const discoveredColumns: readonly Column<DiscoveredTicket>[] = [
    {
      key: "key",
      header: t("col.ticket"),
      cell: (ticket) => (
        <>
          <b className="screen-mono">{ticket.key}</b>
          <div className="screen-note">{ticket.summary}</div>
        </>
      ),
    },
    {
      key: "status",
      header: t("col.status"),
      cell: (ticket) => ticket.status ?? "—",
    },
    {
      key: "start",
      header: "",
      align: "right",
      cell: (ticket) =>
        canStart ? (
          <Button
            variant="primary"
            size="sm"
            busy={start.isPending}
            disabled={running}
            onClick={() => start.mutate(ticket.key)}
          >
            {t("pilot.action.start")}
          </Button>
        ) : (
          <span className="screen-note">{t("pilot.start.viewer")}</span>
        ),
    },
  ];

  return (
    <div className="screen-stack">
      <Card title={t("pilot.intro.title")} subtitle={t("pilot.intro.subtitle")}>
        <p className="screen-note">{t("pilot.intro.body")}</p>
        {state !== undefined ? (
          <p className="screen-note">
            {t("pilot.intro.site", { site: state.jiraSite, group: state.approverGroup })}
          </p>
        ) : null}
      </Card>

      <Card
        title={t("pilot.discovered.title")}
        subtitle={t("pilot.discovered.subtitle")}
        padded={false}
      >
        <QueryState
          isPending={query.isPending}
          error={query.error}
          onRetry={() => void query.refetch()}
          skeletonRows={3}
        >
          <Table
            columns={discoveredColumns}
            rows={state?.discovered ?? []}
            rowKey={(ticket) => ticket.key}
            emptyLabel={t("pilot.discovered.empty")}
            caption={t("pilot.discovered.caption")}
          />
        </QueryState>
      </Card>

      {state !== undefined && state.ticketKey !== null ? (
        <Card
          title={t("pilot.run.title")}
          subtitle={t("pilot.run.subtitle")}
          actions={
            state.browseUrl !== null ? (
              <a
                className="ui-btn ui-btn--sm"
                href={state.browseUrl}
                target="_blank"
                rel="noreferrer noopener"
              >
                {t("pilot.run.open_jira")}
              </a>
            ) : undefined
          }
        >
          <p className="scr-row" style={{ gap: 8, alignItems: "center" }}>
            <b className="screen-mono">{state.ticketKey}</b>
            {running ? (
              <Badge tone="blue">{t("pilot.badge.running")}</Badge>
            ) : state.finished ? (
              <Badge tone="green">{t("pilot.badge.finished")}</Badge>
            ) : (
              <Badge tone="gray">{t("pilot.badge.idle")}</Badge>
            )}
            {state.failure !== null ? <Badge tone="red">{t("pilot.badge.failed")}</Badge> : null}
          </p>

          {gateStep !== null ? (
            <p className="screen-note" role="status">
              <Badge tone="amber">{t("pilot.gate.badge")}</Badge>{" "}
              {t("pilot.gate.instruction", { step: gateStep })}
            </p>
          ) : null}

          <div className="screen-steps" style={{ marginTop: 10 }}>
            {(state.steps ?? []).map((step) => (
              <div className="screen-step" key={step.id}>
                <span className="screen-step__num">{step.id}</span>
                <span className="screen-step__title">
                  {step.title}
                  <span className="screen-note"> {step.hint}</span>
                </span>
                <span className="screen-step__state">
                  <Badge tone={STEP_TONE[step.state]}>{t(`pilot.step.${step.state}`)}</Badge>
                </span>
              </div>
            ))}
          </div>

          {state.docsReady ? (
            <p className="scr-row" style={{ gap: 8, marginTop: 12, alignItems: "center" }}>
              <span className="screen-note">{t("pilot.docs.ready")}</span>
              <DocLink kind="pdf" label={t("pilot.docs.pdf")} />
              <DocLink kind="docx" label={t("pilot.docs.docx")} />
            </p>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}

/**
 * A download button for the generated analysis document. The bytes come through
 * the same authenticated proxy (`/studio/pilot/doc/:kind`) as everything else —
 * `getBlob` carries the session token, which is why this is not a plain `<a>`.
 */
function DocLink({ kind, label }: { readonly kind: "pdf" | "docx"; readonly label: string }): ReactNode {
  const t = useT();
  const api = useApi();
  const toast = useToast();

  const download = async (): Promise<void> => {
    try {
      const blob = await api.getBlob(`/studio/pilot/doc/${kind}`);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `analiz.${kind}`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast.show("error", t(messageKeyOf(error)));
    }
  };

  return (
    <Button size="sm" onClick={() => void download()}>
      {label}
    </Button>
  );
}
