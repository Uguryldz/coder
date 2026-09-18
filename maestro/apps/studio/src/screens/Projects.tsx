import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { useApi, useAuth } from "../auth/AuthProvider.tsx";
import { hasAnyRole } from "../auth/types.ts";
import { useT } from "../i18n/I18nProvider.tsx";
import type { RoutingView } from "./common/admin-api.ts";
import { ButtonLink, Card, EmptyState, Skeleton, Tabs } from "../ui/index.ts";
import { ReposScreen } from "./Onboard.tsx";
import { RoutingScreen } from "./Routing.tsx";
import { ListeningScreen } from "./Listening.tsx";
import { YamlScreen } from "./Yaml.tsx";

/**
 * Screen: projects — what is bound, what listens, which repositories are
 * registered, and the repo-side policy reference.
 *
 * BİNDING İTSELF HAPPENS IN THE WIZARD (`/setup`). This page used to carry a
 * numbered "1 · Uygulama ekle → 2 · onay → 3 · kural" strip that re-did the
 * wizard's job a second time, with a form (gate set, merge mode, data class,
 * dry run, admin approval) that CONTRADICTED it. Measured in a browser tour:
 * two ways to bind, two vocabularies, one of them stale. The strip is gone.
 *
 * What is left is a page of LISTS around a bound project: the bindings and
 * their approval queue, the listening rules, the registered repositories, and
 * the protected-paths reference. A repository is not something a project is
 * "bound to" any more — it comes from a listening rule's repo map, and the
 * "Depolar" tab is the inventory of what that map may pick from.
 *
 * The active tab lives in the URL (`?tab=`). A tab, once opened, STAYS
 * MOUNTED (hidden) when another is shown: the listening form is long, and an
 * operator who hops to "Bağlı projeler" to check a key and comes back must
 * find their half-written rule where they left it. Tabs never opened are not
 * mounted at all, so a fresh page still fires only the queries of the tab it
 * shows.
 */

const TAB_IDS = ["routing", "listening", "repos", "yaml"] as const;
type TabId = (typeof TAB_IDS)[number];

/**
 * Old links: `/onboard` still redirects to `?tab=onboard` and the listening
 * screen's "unbound" note points there too. The former "Uygulama ekle" tab is
 * now "Depolar", so the old id lands on the new tab rather than on nothing.
 */
const TAB_ALIASES: Readonly<Record<string, TabId>> = { onboard: "repos" };

/** Every endpoint behind these tabs (`/routing`, `/onboarding/*`, `/studio/listening-rules`) is admin / tech-lead. */
const PROJECT_ROLES = ["admin", "tech-lead"] as const;

function tabOf(value: string | null): TabId | null {
  if (value === null) return null;
  if ((TAB_IDS as readonly string[]).includes(value)) return value as TabId;
  return TAB_ALIASES[value] ?? null;
}

export function ProjectsScreen(): ReactNode {
  const t = useT();
  const api = useApi();
  const { session } = useAuth();
  const allowed = hasAnyRole(session, PROJECT_ROLES);
  const [params, setParams] = useSearchParams();
  const explicitTab = tabOf(params.get("tab"));

  // How the page opens depends on whether anything is bound yet: a bound
  // install lands on the LIST; a fresh one gets an empty state that sends the
  // admin to the wizard — the one place a project is bound — instead of a
  // second, contradicting form. An explicit `?tab=` always wins, and the read
  // is only made when it decides.
  const routing = useQuery({
    queryKey: ["routing"],
    queryFn: ({ signal }) => api.get<RoutingView>("/routing", { signal }),
    enabled: allowed && explicitTab === null,
  });
  const hasBindings = (routing.data?.projects.length ?? 0) > 0;
  const tab: TabId = explicitTab ?? "routing";
  const showWizardPrompt = explicitTab === null && !routing.isPending && !hasBindings;
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

  // Until the default is known, show nothing that could jump: mounting the
  // list and then swapping in the wizard prompt a beat later is the flicker
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

  return (
    <div className="scr-stack">
      {/* Nothing bound yet: the way in is the wizard, said once, above the
          (empty) list — never a second binding form on this page. */}
      {showWizardPrompt && (
        <Card>
          <EmptyState
            title={t("projects.empty.title")}
            description={t("projects.empty.body")}
            action={
              <ButtonLink variant="primary" to="/setup">
                {t("projects.empty.wizard")}
              </ButtonLink>
            }
          />
        </Card>
      )}

      <Tabs
        label={t("projects.tabs.label")}
        active={tab}
        onChange={select}
        items={TAB_IDS.map((id) => ({ id, label: t(`projects.tab.${id}`) }))}
      />

      {panel("routing", <RoutingScreen />)}
      {panel("listening", <ListeningScreen key={listeningKey} />)}
      {/* Depolar: the registered repositories a listening rule's repo map picks from. */}
      {panel("repos", <ReposScreen />)}
      {/* Korumalı yollar (.maestro.yaml): a project's repo-side policy — reference. */}
      {panel("yaml", <YamlScreen />)}
    </div>
  );
}
