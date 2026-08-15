import type { ReactNode } from "react";
import { ConnectorsPanel } from "./settings/ConnectorsPanel.tsx";
import { KillSwitchPanel } from "./settings/KillSwitchPanel.tsx";
import { PilotSettingsPanel } from "./settings/PilotSettingsPanel.tsx";

/**
 * Ayarlar & bağlantılar — the platform's outbound connections plus the kill
 * switch.
 *
 * Two sections, both real:
 *  · {@link ConnectorsPanel} — the ADMIN-EDITABLE outbound connections (Jira,
 *    GitHub, OpenRouter…): add a URL + token, test it LIVE, token stored
 *    AES-encrypted and shown only as a mask (M9/migration 0010).
 *  · {@link KillSwitchPanel} — the two-level emergency stop (M58).
 *  · {@link PilotSettingsPanel} — the flow engine's runtime settings, proxied
 *    to the pilot (`/studio/pilot/settings`); schema-agnostic so engine-side
 *    additions survive a Studio round-trip.
 *
 * The old read-only "deployment facts" connection table and the stub
 * notify-driver table were removed: the first duplicated the editable panel
 * under the same heading, and notify drivers live on the dedicated "Bildirim &
 * eskalasyon" screen (M45).
 */
export function SettingsScreen(): ReactNode {
  return (
    <div className="scr-stack">
      <ConnectorsPanel />
      <PilotSettingsPanel />
      <KillSwitchPanel />
    </div>
  );
}
