import type { ReactNode } from "react";
import { useSearchParams } from "react-router";
import { useT } from "../i18n/I18nProvider.tsx";
import { TabPanel, Tabs } from "../ui/index.ts";
import { PilotScreen } from "./Pilot.tsx";
import { FlowScreen } from "./Flow.tsx";
import "./shared/screens.css";

/**
 * Screen: watch (/pilot) — "Canlı akış", one page with two views of the SAME
 * live data (`/studio/pilot/state`).
 *
 * Pilot and Flow used to be two separate menu rows: one showed the running work
 * as a table (with a Start button), the other drew the 9-step process as a
 * diagram. They read the same state, so they are now two tabs — "Canlı liste"
 * (what is running, and start one) and "Süreç haritası" (the same steps as a
 * picture). The old /flow path redirects here with the map tab selected.
 *
 * Each tab renders the ORIGINAL screen unchanged; the tab lives in the URL
 * (`?view=`) so the redirect and deep links work.
 */

const VIEWS = ["list", "map"] as const;
type ViewId = (typeof VIEWS)[number];

function isView(v: string | null): v is ViewId {
  return v === "list" || v === "map";
}

export function WatchScreen(): ReactNode {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const view: ViewId = isView(params.get("view")) ? (params.get("view") as ViewId) : "list";

  const select = (id: string): void => {
    const next = new URLSearchParams(params);
    next.set("view", id);
    setParams(next, { replace: false });
  };

  return (
    <div className="scr-stack">
      <Tabs
        label={t("watch.tabs.label")}
        active={view}
        onChange={select}
        items={VIEWS.map((id) => ({ id, label: t(`watch.tab.${id}`) }))}
      />
      <TabPanel id="list" active={view}>
        <PilotScreen />
      </TabPanel>
      <TabPanel id="map" active={view}>
        <FlowScreen />
      </TabPanel>
    </div>
  );
}
