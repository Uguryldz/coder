import type { ReactNode } from "react";
import { ConnectorsPanel } from "./settings/ConnectorsPanel.tsx";

/**
 * Bağlantılar — the platform's outbound connections, and nothing else.
 *
 * This screen used to stack three unrelated panels: the editable connectors,
 * a read-only copy of the deployment's infrastructure (which the health screen
 * probed a second time), and the kill switch. The infrastructure facts and the
 * emergency stop now live on Sistem sağlığı, where an operator asking "is it
 * up, and can I stop it" already is; what an operator MANAGES stays here.
 */
export function SettingsScreen(): ReactNode {
  return <ConnectorsPanel />;
}
