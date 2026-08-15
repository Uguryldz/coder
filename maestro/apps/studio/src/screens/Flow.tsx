import { useMemo } from "react";
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useT } from "../i18n/I18nProvider.tsx";
import { useApi } from "../auth/AuthProvider.tsx";
import { Badge, Card } from "../ui/index.ts";
import { ACTOR_ORDER, actorLabelKey } from "./flow/agentPipeline.ts";
import { layoutPipeline } from "./flow/pipelineLayout.ts";
import {
  AgentPipelineDiagram,
  type LiveStateMap,
  type LiveStepState,
} from "./flow/AgentPipelineDiagram.tsx";
import "./flow/flow.css";
import "./shared/screens.css";

/**
 * Screen: flow — the AGENT pipeline ("hangi adımda hangi ajan ne iş yapıyor").
 *
 * Not Jira's status diagram (that was the old version, and it answered the wrong
 * question). This draws MAESTRO'S OWN nine-step machine — the one apps/pilot runs
 * — as a picture: each node is an ACTOR (Maestro / an AI agent / a human gate)
 * and its task, with the İADE and re-analysis branches drawn explicitly.
 *
 * LIVE POSITION comes from the running pilot. We poll `/studio/pilot/state` (the
 * exact channel the Pilot screen uses) and colour each node by the live
 * `steps[].state` for its id, so "hangi adımdayız" lights up on the real run —
 * no invented position. When nothing is running the map still reads cleanly with
 * no rings; it is a reference diagram as much as a live monitor.
 *
 * The layout is a pure function (flow/pipelineLayout.ts) with zero graph
 * libraries (bank CSP), and the step ids are asserted against the pilot's
 * STEP_DEFINITIONS by the test — the only coupling between this map and the
 * frozen run contract.
 */

/** How often the live position refreshes (ms) — matches the Pilot screen feel. */
const PILOT_REFRESH_MS = 2000;

/** Mirror of the pilot state fields this screen reads (apps/pilot/src/state.ts). */
interface PilotStepWire {
  readonly id: string;
  readonly state: LiveStepState;
}
interface PilotStateWire {
  readonly ticketKey: string | null;
  readonly running: boolean;
  readonly awaitingGate: string | null;
  readonly steps: readonly PilotStepWire[];
}

export function FlowScreen(): ReactNode {
  const t = useT();
  const api = useApi();

  const layout = useMemo(() => layoutPipeline(), []);

  // The live run position. `retry: false` so a pilot that is simply not up shows
  // the reference map (via the catch below) rather than a spinner forever.
  const query = useQuery({
    queryKey: ["pilot-state", "flow"],
    queryFn: ({ signal }) => api.get<PilotStateWire>("/studio/pilot/state", { signal }),
    refetchInterval: PILOT_REFRESH_MS,
    retry: false,
  });

  const state = query.data;

  // Fold the pilot's steps[] into an id→state map the diagram consumes.
  const live: LiveStateMap = useMemo(() => {
    const map: Record<string, LiveStepState> = {};
    for (const step of state?.steps ?? []) map[step.id] = step.state;
    return map;
  }, [state]);

  // The active node: the open gate wins (a human is being waited on), else the
  // single step currently "calisiyor". Null when idle — no ring.
  const activeId = useMemo(() => {
    if (state?.awaitingGate != null) return state.awaitingGate;
    const running = (state?.steps ?? []).find((s) => s.state === "calisiyor");
    return running?.id ?? null;
  }, [state]);

  const stateLabel = (s: LiveStepState): string => t(`flow.state.${s}`);

  const running = state?.running ?? false;

  return (
    <div className="screen-stack">
      <Card title={t("flow.title")} subtitle={t("flow.sub")}>
        <p className="screen-note">{t("flow.intro")}</p>
        {state !== undefined && (
          <p className="screen-note" role="status">
            {running && state.ticketKey != null
              ? t("flow.live.on", { ticket: state.ticketKey })
              : t("flow.live.idle")}
          </p>
        )}
      </Card>

      <Card padded={false}>
        <div style={{ padding: 14 }}>
          {/* The diagram never depends on the pilot being up — a failed/absent
              query just means no live rings. So render the map unconditionally
              and let QueryState narrate only the (optional) live layer. */}
          <AgentPipelineDiagram
            layout={layout}
            live={live}
            activeId={activeId}
            title={t("flow.diagram.title")}
            description={t("flow.diagram.desc", {
              n: String(layout.nodes.length),
            })}
            stateLabel={stateLabel}
          />

          <div className="flow-legend" style={{ marginTop: 12 }}>
            {ACTOR_ORDER.map((actor) => (
              <span key={actor} className="flow-legend-item">
                <span className={`flow-swatch pl-swatch--${actor}`} />
                {t(actorLabelKey(actor))}
              </span>
            ))}
            <span className="flow-legend-item">
              <span className="flow-swatch flow-swatch--active" />
              {t("flow.legend.active")}
            </span>
          </div>

          {query.isError && (
            <p className="screen-note" style={{ marginTop: 10 }}>
              {t("flow.live.offline")}
            </p>
          )}

          {activeId != null && (
            <p className="screen-note" style={{ marginTop: 8 }} role="status">
              <Badge tone="purple">{t("flow.here")}</Badge>{" "}
              {t("flow.position.step", { step: activeId })}
            </p>
          )}
        </div>
      </Card>
    </div>
  );
}
