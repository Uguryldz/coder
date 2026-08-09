import type { ParamChange, ParamDefinition, Role } from "@maestro/contracts";

/**
 * Wire shapes for the platform-management screens.
 *
 * Only `/params` and `/killswitch` exist in the BFF today; everything else here
 * is the contract this cluster of screens needs and RAPOR-ekranlar-B.md files
 * as an endpoint request. They are declared in one place on purpose: when the
 * BFF agent lands a route, exactly one file has to agree with it, and a shape
 * that drifts fails typecheck rather than rendering wrong numbers.
 *
 * Nothing here fabricates data. A screen whose endpoint is missing shows the
 * error state — a management console that invents a healthy runner is worse
 * than one that admits it cannot reach the server.
 */

// ── /params (LIVE: GET /params, PUT /params/:key) ─────────────────────────────

export interface PendingParamChange {
  readonly key: string;
  readonly scopeRef: string | null;
  readonly value: unknown;
  readonly proposedBy: string;
  readonly at: string;
}

/** GET /params */
export interface ParamsView {
  readonly definitions: readonly ParamDefinition[];
  readonly values: readonly ParamChange[];
  readonly pending: readonly PendingParamChange[];
}

/** PUT /params/:key — 200 applied, 202 waiting for the second approver. */
export type ParamPutResult =
  | { readonly status: "applied"; readonly change: ParamChange }
  | { readonly status: "pending"; readonly pending: PendingParamChange };

// ── /killswitch (LIVE: GET, POST) ─────────────────────────────────────────────

export type KillSwitchLevel = "off" | "intake_only" | "all";

export interface KillSwitchState {
  readonly level: KillSwitchLevel;
  readonly actor: string;
  readonly reason: string;
  readonly at: string;
}

export interface KillSwitchResult {
  readonly state: KillSwitchState;
  /** Workflow ids that were told to stop; empty for `intake_only` and `off`. */
  readonly stopped: readonly string[];
}

// ── /users (REQUESTED) ────────────────────────────────────────────────────────

export interface ManagedUser {
  readonly userId: string;
  readonly username: string;
  readonly displayName: string;
  readonly groups: readonly string[];
  readonly roles: readonly Role[];
  /**
   * False means the account is revoked. It is a first-class field rather than
   * an absence so a disabled account still LISTS — an account that vanishes
   * from the table looks deleted, and the operator stops checking whether its
   * sessions actually died.
   */
  readonly active: boolean;
  /** Live sessions still bearing a token for this account, if any. */
  readonly activeSessions: number;
  readonly lastLoginAt: string | null;
}

export interface UsersView {
  readonly users: readonly ManagedUser[];
  /** Separation-of-duty rules and whether each is enforced (M92). */
  readonly sod: readonly SodRule[];
  readonly serviceAccount: ServiceAccountView | null;
}

export interface SodRule {
  readonly id: string;
  readonly enforced: boolean;
}

export interface ServiceAccountView {
  readonly account: string;
  readonly jira: string;
  readonly ado: string;
  readonly commitSignature: string;
  readonly credentialTtlMinutes: number;
}

// ── /runners, /sandbox (REQUESTED) ────────────────────────────────────────────

export type RunnerStatus = "ok" | "warn" | "unreachable";

export interface RunnerNode {
  readonly id: string;
  readonly host: string;
  readonly pool: string;
  readonly platform: string;
  readonly capacity: number;
  readonly busy: number;
  readonly jobs: readonly string[];
  readonly status: RunnerStatus;
  /** Catalog key describing the warning; never prose from the server. */
  readonly messageKey: string | null;
  readonly lastSeenAt: string;
}

export interface RunnersView {
  readonly runners: readonly RunnerNode[];
}

export interface SandboxSession {
  readonly sessionId: string;
  readonly ticketKey: string;
  readonly runnerId: string;
  readonly pool: string;
  readonly image: string;
  readonly workspaceMounted: boolean;
  readonly resumed: boolean;
  readonly turn: number;
  readonly memoryMb: number;
  readonly cpus: number;
  readonly pids: number;
  readonly timeoutMinutes: number;
  readonly egressTargets: number;
  readonly startedAt: string;
  readonly tools: readonly { readonly name: string; readonly scope: string }[];
}

export interface SandboxView {
  readonly sessions: readonly SandboxSession[];
}

// ── /health (REQUESTED; /healthz + /readyz exist but carry no detail) ─────────

export type ServiceStatus = "ok" | "degraded" | "down";

export interface ServiceHealth {
  readonly id: string;
  readonly status: ServiceStatus;
  readonly version: string | null;
  readonly uptimeSeconds: number | null;
  /** Catalog key for the note column, with optional interpolation params. */
  readonly noteKey: string | null;
  readonly noteParams?: Readonly<Record<string, string>>;
}

export interface HealthView {
  readonly services: readonly ServiceHealth[];
  readonly workflows: {
    readonly open: number;
    readonly longestDays: number;
    readonly continueAsNew: number;
    readonly failedActivities: number;
  };
  readonly backup: {
    readonly databaseAt: string | null;
    readonly vaultAt: string | null;
    readonly restoreDrillAt: string | null;
  };
  readonly audit: {
    readonly queued: number;
    readonly lastShippedAt: string | null;
    readonly lastAnchorAt: string | null;
  };
}

// ── /settings (REQUESTED) ─────────────────────────────────────────────────────

export type ConnectionStatus = "connected" | "degraded" | "unconfigured";

export interface Connection {
  readonly id: string;
  readonly endpoint: string;
  readonly status: ConnectionStatus;
  /** Vault path or auth method — never the secret itself. */
  readonly credentialRef: string;
  readonly checkedAt: string | null;
}

export interface NotifyDriver {
  readonly channel: string;
  readonly enabled: boolean;
  readonly target: string;
}

export interface SettingsView {
  readonly connections: readonly Connection[];
  readonly notifyDrivers: readonly NotifyDriver[];
}

// ── /notify (REQUESTED) ───────────────────────────────────────────────────────

export interface EscalationStep {
  readonly afterHours: number;
  readonly channels: readonly string[];
  /** `delegate` and `report` steps render differently from a plain reminder. */
  readonly kind: "notify" | "delegate" | "report";
}

export interface Delegation {
  readonly role: Role;
  readonly primary: string;
  readonly backup: string | null;
  readonly lastResort: string | null;
}

export interface WaitingGate {
  readonly ticketKey: string;
  readonly step: string;
  readonly waitingHours: number;
  readonly lastActionKey: string | null;
  readonly lastActionParams?: Readonly<Record<string, string>>;
}

export interface NotifyView {
  readonly ladder: readonly EscalationStep[];
  readonly delegations: readonly Delegation[];
  readonly waiting: readonly WaitingGate[];
}

// ── /mcp (REQUESTED) ──────────────────────────────────────────────────────────

export type McpScope = "read" | "operate" | "admin-proposal";

export interface McpTool {
  readonly name: string;
  readonly scope: McpScope;
  /** Catalog key describing the tool (M104). */
  readonly descriptionKey: string;
}

export interface McpView {
  readonly endpoint: string;
  readonly auditActor: string;
  readonly tools: readonly McpTool[];
  /** Tools deliberately absent — listed so the boundary is visible, not implied. */
  readonly forbiddenTools: readonly string[];
}

// ── /commands (REQUESTED) ─────────────────────────────────────────────────────

export interface JiraCommand {
  readonly name: string;
  readonly roles: readonly Role[];
  readonly takesArgument: boolean;
  /** Catalog keys — the BFF must not send prose (M104). */
  readonly whenKey: string;
  readonly effectKey: string;
}

export interface CommandsView {
  readonly commands: readonly JiraCommand[];
}

// ── /repo-policy (REQUESTED) — the .maestro.yaml screen ───────────────────────

export interface RepoPolicy {
  readonly appId: string;
  readonly platform: string;
  readonly repo: string;
  /** The file as it exists in the repo; read-only in Studio. */
  readonly yaml: string;
  /**
   * Protected paths (M52). Platform defaults are separated from repo additions
   * because a default may be ADDED TO but never removed — a UI that mixed them
   * into one editable list would imply a delete that the server refuses.
   */
  readonly protectedPaths: {
    readonly platformDefaults: readonly string[];
    readonly repoAdditions: readonly string[];
  };
  readonly fetchedAt: string | null;
}

export interface RepoPolicyView {
  readonly policies: readonly RepoPolicy[];
}

/** Onboarding wire shapes live in ./onboarding-api.ts. */
