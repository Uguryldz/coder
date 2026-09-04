import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { useApi, useAuth } from "../auth/AuthProvider.tsx";
import { hasAnyRole } from "../auth/types.ts";
import { useT } from "../i18n/I18nProvider.tsx";
import type { RoutingView } from "./common/admin-api.ts";
import { Card, Skeleton, Tabs } from "../ui/index.ts";
import { OnboardScreen } from "./Onboard.tsx";
import { RoutingScreen } from "./Routing.tsx";
import { ListeningScreen } from "./Listening.tsx";
import { YamlScreen } from "./Yaml.tsx";

/**
 * Screen: projects — one page for the three steps of binding a project, plus
 * the repo-side policy reference.
 *
 * The three steps are one SEQUENTIAL workflow around a single `projectKey`:
 * ADD an application (or run the wizard), a second admin APPROVES it into a
 * binding, then the LISTENING rules decide which tickets Maestro picks up. The
 * tabs are numbered so their order reads as steps, and one line under the
 * strip says what the current step does — the numbered tabs and a separate
 * journey card used to say the same thing twice.
 *
 * The active tab lives in the URL (`?tab=`). A tab, once opened, STAYS
 * MOUNTED (hidden) when another is shown: the listening form is long, and an
 * operator who hops to "Bağlı projeler" to check a key and comes back must
 * find their half-written rule where they left it. Tabs never opened are not
 * mounted at all, so a fresh page still fires only the queries of the tab it
 * shows.
 */

const TAB_IDS = ["onboard", "routing", "listening", "yaml"] as const;
type TabId = (typeof TAB_IDS)[number];

/** The three binding STEPS; "yaml" is a reference tab. */
const JOURNEY_IDS = ["onboard", "routing", "listening"] as const;

/** Every endpoint behind these tabs (`/routing`, `/onboarding/*`, `/studio/listening-rules`) is admin / tech-lead. */
const PROJECT_ROLES = ["admin", "tech-lead"] as const;

function isTab(value: string | null): value is TabId {
  return (TAB_IDS as readonly string[]).includes(value ?? "");
}

export function ProjectsScreen(): ReactNode {
  const t = useT();
  const api = useApi();
  const { session } = useAuth();
  const allowed = hasAnyRole(session, PROJECT_ROLES);
  const [params, setParams] = useSearchParams();
  const raw = params.get("tab");
  const explicitTab = isTab(raw) ? raw : null;

  // How the page opens depends on whether anything is bound yet: a fresh
  // install lands on "add an application", a bound one on the LIST — landing
  // an admin on an empty add-form hides the very thing they came to see. An
  // explicit `?tab=` always wins, and the read is only made when it decides.
  const routing = useQuery({
    queryKey: ["routing"],
    queryFn: ({ signal }) => api.get<RoutingView>("/routing", { signal }),
    enabled: allowed && explicitTab === null,
  });
  const hasBindings = (routing.data?.projects.length ?? 0) > 0;
  const fallback: TabId = hasBindings ? "routing" : "onboard";
  const tab: TabId = explicitTab ?? fallback;
  // Which tabs have been shown so far — these stay mounted. Seeded with the
  // first tab shown, never with the transient default a pending read implies.
  const [visited, setVisited] = useState<ReadonlySet<TabId>>(() => new Set());
  useEffect(() => {
    if (explicitTab !== null || !routing.isPending) {
      setVisited((prev) => (prev.has(tab) ? prev : new Set(prev).add(tab)));
    }
  }, [tab, explicitTab, routing.isPending]);
  // The listening form is pre-filled from `?projectKey=` at mount. Re-mount it
  // only when a NEW key arrives on that tab (an approval sending the operator
  // there), never on a plain tab switch — that is what would drop the draft.
  const projectKeyParam = params.get("projectKey");
  const [listeningKey, setListeningKey] = useState(projectKeyParam ?? "");
  useEffect(() => {
    if (tab === "listening" && projectKeyParam !== null && projectKeyParam !== "") setListeningKey(projectKeyParam);
  }, [tab, projectKeyParam]);

  const select = (id: string): void => {
    const next = new URLSearchParams(params);
    next.set("tab", id);
    // A tab switch is not a project selection: the stale `projectKey` leaves
    // the URL (the listening form keeps its own state regardless).
    if (id !== tab) next.delete("projectKey");
    setParams(next, { replace: false });
  };

  if (!allowed) {
    return (
      <Card title={t("projects.roles.title")}>
        <p className="scr-prose">{t("projects.roles.body")}</p>
      </Card>
    );
  }

  // Until the default tab is known, show nothing that could jump: mounting
  // "Uygulama ekle" and then switching to the list a beat later is the flicker
  // this wait exists to end.
  if (explicitTab === null && routing.isPending) {
    return (
      <Card>
        <Skeleton />
      </Card>
    );
  }

  const panel = (id: TabId, node: ReactNode): ReactNode =>
    visited.has(id) || id === tab ? (
      <div role="tabpanel" id={`panel-${id}`} aria-labelledby={`tab-${id}`} hidden={id !== tab}>
        {node}
      </div>
    ) : null;
  const journeyIndex = (JOURNEY_IDS as readonly string[]).indexOf(tab);

  return (
    <div className="scr-stack">
      <div>
        <Tabs
          label={t("projects.tabs.label")}
          active={tab}
          onChange={select}
          items={TAB_IDS.map((id, i) => ({
            id,
            label: i < JOURNEY_IDS.length ? `${i + 1} · ${t(`projects.tab.${id}`)}` : t(`projects.tab.${id}`),
          }))}
        />
        {/* What THIS step does, in one line — the journey, without a second card. */}
        {journeyIndex >= 0 && <p className="scr-hint">{t(`projects.journey.step.${tab}`)}</p>}
      </div>

      {panel("onboard", <OnboardScreen />)}
      {panel("routing", <RoutingScreen />)}
      {panel("listening", <ListeningScreen key={listeningKey} />)}
      {/* Korumalı yollar (.maestro.yaml): a project's repo-side policy — reference, not a step. */}
      {panel("yaml", <YamlScreen />)}
    </div>
  );
}
