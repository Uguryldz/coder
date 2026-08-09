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

// ── /studio/users/:username (LIVE — single lookup only) ───────────────────────

/**
 * What `GET /studio/users/:username` returns. Deliberately thin: the directory
 * is the source of truth and this is a window onto it, so there is no password
 * material and no session inventory.
 *
 * There is NO list endpoint and no mutation. Roles are granted in the directory
 * (M8), not in Studio, which is why the users screen is a lookup rather than a
 * table with edit buttons — see the note in Users.tsx.
 */
export interface DirectoryUser {
  readonly username: string;
  readonly userId: string;
  readonly roles: readonly Role[];
  readonly groups: readonly string[];
  /** False when the directory has revoked the account. */
  readonly active: boolean;
}

// ── paging (LIVE: every /studio list endpoint) ────────────────────────────────

/**
 * Every list endpoint is bounded (M7): a page plus an opaque cursor.
 * `nextCursor: null` means "that was the last page", which is not the same as
 * a short page — a full final page is not a signal.
 */
export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

// ── /studio/runners, /studio/sandboxes (LIVE) ─────────────────────────────────

export type RunnerState = "idle" | "busy" | "draining" | "unreachable";

/** A row of `GET /studio/runners` (BFF `RunnerRecord`). */
export interface RunnerRecord {
  readonly runnerId: string;
  readonly pool: string;
  readonly platform: string;
  readonly state: RunnerState;
  readonly capacity: number;
  readonly activeSandboxes: number;
  readonly lastHeartbeatAt: string;
  /** Why a runner is not fully healthy; `null` when it is. */
  readonly note: string | null;
}

/** Per-pool capacity, summed by the BFF so client and server never disagree. */
export interface PoolSummary {
  readonly pool: string;
  readonly capacity: number;
  readonly busy: number;
  readonly machines: number;
  readonly unhealthy: number;
}

export interface RunnersResponse extends Page<RunnerRecord> {
  readonly pools: readonly PoolSummary[];
}

export type SandboxState = "active" | "resumable" | "human_held";

/** A row of `GET /studio/sandboxes` (BFF `SandboxRecord`). */
export interface SandboxRecord {
  readonly ticketKey: string;
  readonly runnerId: string;
  readonly state: SandboxState;
  readonly sizeBytes: number;
  readonly lastAccessAt: string;
}

// ── /studio/health (LIVE) ─────────────────────────────────────────────────────

export type ServiceState = "healthy" | "degraded" | "down";

/** A row of `GET /studio/health` (BFF `ServiceHealth`). */
export interface ServiceHealth {
  readonly service: string;
  readonly state: ServiceState;
  readonly version: string;
  readonly checkedAt: string;
  readonly note: string | null;
}

export interface HealthResponse {
  /** Worst state across the services, computed by the BFF. */
  readonly state: ServiceState;
  readonly services: readonly ServiceHealth[];
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
