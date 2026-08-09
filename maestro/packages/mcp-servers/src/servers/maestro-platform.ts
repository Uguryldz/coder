import type {
  JournalEntry,
  ParamKey,
  RepoCard,
  WorkflowRunState,
  WorkflowRunStatus,
  WorkMode,
} from "@maestro/contracts";

/** A run as `get_run` returns it: the contract state plus what a human would ask next. */
export interface RunDetail {
  readonly state: WorkflowRunState;
  readonly appId: string | null;
  readonly mode: WorkMode;
  /** Set while the run sits on a human gate — who owns it and since when (M101 read scope). */
  readonly pendingGate: {
    readonly step: string;
    readonly ownerGroup: string;
    readonly openedAt: string;
    readonly waitingDays: number;
  } | null;
}

export interface ParamView {
  readonly key: ParamKey;
  readonly scope: string;
  readonly scopeRef: string | null;
  readonly value: unknown;
  readonly guarded: boolean;
  readonly version: number;
}

/**
 * The result of `propose_param_change`. `status` is a single literal on
 * purpose: there is no shape this type can take that means "applied". A
 * platform implementation that applied the change would have to lie about its
 * return value, and `maestroMcpServer` checks the value it gets back.
 */
export interface ParamChangeProposal {
  readonly proposalId: string;
  readonly key: ParamKey;
  readonly scopeRef: string | null;
  readonly status: "pending_four_eyes";
  /** Group that must supply the second pair of eyes (M71 guarded params, M32). */
  readonly approverGroup: string;
}

export interface KnowledgeHit {
  readonly id: string;
  readonly title: string;
  readonly snippet: string;
  readonly source: string;
  readonly score: number;
}

/**
 * Everything `maestro-mcp` needs from the platform (M101), as one injected
 * interface. The BFF implements it over the DB, the workflow client and the
 * knowledge index; this package imports none of those (M44).
 *
 * Every method takes `actingUser`: the platform applies THAT user's RBAC. The
 * MCP layer checks tool scopes, which is a coarse filter over what the tool
 * category is; it is not, and must not be mistaken for, the row-level
 * authorisation the platform already owns. An AI holding a token gets exactly
 * what the person holding it would get — no wider, and nothing extra because
 * the request arrived over MCP.
 */
export interface MaestroPlatform {
  listRuns(
    actingUser: string,
    filter: {
      status: WorkflowRunStatus | undefined;
      ticketKey: string | undefined;
      appId: string | undefined;
      limit: number;
    },
  ): Promise<readonly WorkflowRunState[]>;

  getRun(actingUser: string, runId: string): Promise<RunDetail>;

  getJournal(
    actingUser: string,
    runId: string,
    range: { fromSeq: number; limit: number },
  ): Promise<readonly JournalEntry[]>;

  getParams(
    actingUser: string,
    filter: { scope: string | undefined; scopeRef: string | undefined },
  ): Promise<readonly ParamView[]>;

  /** MUST enqueue for four-eyes review and MUST NOT apply the change (M71/M101). */
  proposeParamChange(
    actingUser: string,
    proposal: { key: string; scopeRef: string | null; value: unknown; reason: string },
  ): Promise<ParamChangeProposal>;

  startWorkflow(
    actingUser: string,
    args: { ticketKey: string; mode: WorkMode | undefined },
  ): Promise<{ runId: string; ticketKey: string }>;

  assignApp(
    actingUser: string,
    args: { ticketKey: string; appId: string },
  ): Promise<{ ticketKey: string; appId: string }>;

  getRepoCard(actingUser: string, appId: string): Promise<RepoCard>;

  searchKnowledge(
    actingUser: string,
    query: { text: string; appId: string | undefined; limit: number },
  ): Promise<readonly KnowledgeHit[]>;
}
