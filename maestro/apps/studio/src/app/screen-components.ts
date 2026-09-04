import type { ComponentType } from "react";
import { AuditScreen } from "../screens/Audit.tsx";
import { AiUsageScreen } from "../screens/AiUsage.tsx";
import { DashScreen } from "../screens/Dash.tsx";
import { DetailScreen } from "../screens/Detail.tsx";
import { DoctemplateScreen } from "../screens/Doctemplate.tsx";
import { EvidenceScreen } from "../screens/Evidence.tsx";
import { HealthScreen } from "../screens/Health.tsx";
import { HelpScreen } from "../screens/Help.tsx";
import { KnowledgeScreen } from "../screens/Knowledge.tsx";
import { NotifyScreen } from "../screens/Notify.tsx";
import { ProjectsScreen } from "../screens/Projects.tsx";
import { ParamsScreen } from "../screens/Params.tsx";
import { PiiScreen } from "../screens/Pii.tsx";
import { SandboxScreen } from "../screens/Sandbox.tsx";
import { SettingsScreen } from "../screens/Settings.tsx";
import { SetupScreen } from "../screens/Setup.tsx";
import { TemplateScreen } from "../screens/Template.tsx";
import { UsersScreen } from "../screens/Users.tsx";
import { VariantScreen } from "../screens/Variant.tsx";
import { VariantsScreen } from "../screens/Variants.tsx";
import { YamlScreen } from "../screens/Yaml.tsx";

/**
 * id -> component. Mirrors src/app/screens.ts; every SCREENS row must have an
 * entry here (test/routes.test.tsx asserts it both ways).
 *
 * Not here on purpose: Eval. Its read model answers 503 `capability_not_wired`
 * in every deployment — no data source exists — and a page that can only ever
 * say "yakında" is not a page. Security and Runners were in the same state and
 * have been deleted; Issues became the "Kararlar" tab of Audit; Commands and
 * Mcp became two tabs of Help (/commands and /mcp redirect there).
 */
export const SCREEN_COMPONENTS: Readonly<Record<string, ComponentType>> = {
  dash: DashScreen,
  help: HelpScreen,
  detail: DetailScreen,
  sandbox: SandboxScreen,
  yaml: YamlScreen,
  variants: VariantsScreen,
  variant: VariantScreen,
  knowledge: KnowledgeScreen,
  template: TemplateScreen,
  doctemplate: DoctemplateScreen,
  pii: PiiScreen,
  cost: AiUsageScreen,
  audit: AuditScreen,
  evidence: EvidenceScreen,
  notify: NotifyScreen,
  setup: SetupScreen,
  projects: ProjectsScreen,
  params: ParamsScreen,
  users: UsersScreen,
  settings: SettingsScreen,
  health: HealthScreen,
};
