import type { CommandIntakeStatusReader } from "@maestro/bff";

/**
 * HOW ticket commands reach this deployment — the operator's answer, and the
 * loop that honours it.
 *
 * `/approve` and `/reject <sebep>` arrive as ticket comments, and there are
 * exactly two ways to read one: Jira calls us (`POST /webhooks/jira`), or we
 * ask Jira (`jira-poller.ts`). Until this module existed, choosing between them
 * meant setting `JIRA_POLL_MS` — an environment variable, in a file, on a
 * server a bank operator has no shell on, read once at boot. The observable
 * consequence was the worst kind: an operator approved a run in the only place
 * they had been told to, the comment was never read, and the gate waited
 * forever with nothing anywhere naming the cause.
 *
 * So the answer moved to a parameter the setup wizard asks for in words
 * ("Jira bize haber versin" / "biz Jira'ya soralım" / "ikisi birden"), and this
 * module is what makes that answer real:
 *
 *  · {@link resolveCommandIntake} decides what is in force, with the parameter
 *    winning over the environment and the environment surviving as the
 *    boot-time default for installs that already set it;
 *  · {@link startCommandIntake} runs a SUPERVISOR that re-reads the answer and
 *    starts or stops the poller accordingly — so a change saved from the panel
 *    applies without a container restart, which on a bank's server is a change
 *    request rather than a click.
 *
 * It lives in its own module rather than inside `bin/bff.ts` because the
 * composition root cannot be unit-tested and this logic has to be: "the stored
 * parameter beats `JIRA_POLL_MS`" and "a driver that cannot read comments never
 * polls, whatever the parameter says" are precisely the rules that fail
 * silently when they are wrong.
 */

/** The three answers `jira.command_intake` can hold. */
export type CommandIntakeMode = "webhook" | "poll" | "both";

/** Where the value in force came from — the wizard shows this to the operator. */
export type CommandIntakeSource = "param" | "env" | "default";

export interface CommandIntakeDecision {
  readonly mode: CommandIntakeMode;
  /** Seconds between rounds; 0 when nothing polls. */
  readonly pollSeconds: number;
  readonly source: CommandIntakeSource;
}

/** The stored parameters, as the resolver needs them. Both may be absent. */
export interface StoredCommandIntake {
  /** `jira.command_intake`; anything that is not one of the three modes is ignored. */
  readonly mode?: unknown;
  /** `jira.poll_seconds`; anything that is not a finite number is ignored. */
  readonly pollSeconds?: unknown;
}

/** The default interval when polling is asked for with no interval stored. */
export const DEFAULT_POLL_SECONDS = 60;

function isMode(value: unknown): value is CommandIntakeMode {
  return value === "webhook" || value === "poll" || value === "both";
}

function finitePositive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * What is in force: the stored answer, or the legacy environment variable, or
 * webhook-only.
 *
 * THE PRECEDENCE, and why it is this way round:
 *
 *  1. The stored parameter WINS whenever it is present. It is the operator's
 *     own answer, given on a screen, and a deployment file quietly overriding
 *     what someone chose in the panel is how a setting becomes untrustworthy.
 *  2. `JIRA_POLL_MS` is honoured when no parameter is stored. This is the
 *     backwards-compatibility rule and it is not decorative: installs already
 *     running today set that variable and nothing else, and an upgrade that
 *     silently stopped polling them would close nothing and break every gate
 *     they approve from a ticket. Its presence means "poll" — the variable only
 *     ever existed to turn polling on — and its milliseconds become seconds.
 *  3. Absent both, webhook-only. The conservative answer: it asks Jira for
 *     nothing, and it is what a deployment with a working webhook wants.
 *
 * `poll`/`both` with no usable interval falls back to {@link DEFAULT_POLL_SECONDS}
 * rather than to zero. Zero would mean "polling is on and never runs", which is
 * the same silent no-op the operator came to this setting to escape.
 */
export function resolveCommandIntake(
  stored: StoredCommandIntake,
  envPollMs: string | undefined,
): CommandIntakeDecision {
  const storedMode = isMode(stored.mode) ? stored.mode : null;
  const storedSeconds = finitePositive(stored.pollSeconds);

  if (storedMode !== null) {
    if (storedMode === "webhook") return { mode: "webhook", pollSeconds: 0, source: "param" };
    return {
      mode: storedMode,
      pollSeconds: storedSeconds ?? DEFAULT_POLL_SECONDS,
      source: "param",
    };
  }

  // No stored answer: the legacy variable still decides, so an install that has
  // been polling since before this setting existed keeps polling.
  const envMs = Number((envPollMs ?? "").trim());
  if (Number.isFinite(envMs) && envMs > 0) {
    return {
      mode: "poll",
      // Rounded UP to a whole second, and never to zero: `JIRA_POLL_MS=500` is
      // half a second, and flooring it would turn a configured poller into a
      // silently disabled one.
      pollSeconds: Math.max(1, Math.ceil(envMs / 1000)),
      source: "env",
    };
  }

  return { mode: "webhook", pollSeconds: 0, source: "default" };
}

/** Whether this decision means Maestro asks Jira at an interval. */
export function intakePolls(mode: CommandIntakeMode): boolean {
  return mode !== "webhook";
}

/** A running poller, as `startJiraPoller` returns one. */
export interface StoppablePoller {
  stop: () => void;
}

export interface CommandIntakeOptions {
  /**
   * Reads the two stored parameters. Called on every supervision round, which
   * is what makes a change saved from the panel apply without a restart.
   */
  readonly readStored: () => Promise<StoredCommandIntake>;
  /** `JIRA_POLL_MS`, for the backwards-compatibility rule above. */
  readonly envPollMs: string | undefined;
  /**
   * Whether the work driver can read a comment thread at all — the BFF's
   * `canReadComments`, asked once at boot because a driver does not grow a
   * method at runtime.
   *
   * `false` pins this deployment to webhook-only NO MATTER what is stored: a
   * poller on a driver with no `listComments` throws once per ticket per
   * interval into a log nobody reads, which is exactly the failure the
   * capability check was added to end. The status reader keeps reporting the
   * stored answer honestly, and the wizard refuses to offer it.
   */
  readonly canReadComments: boolean;
  /** Starts the real poller at an interval. Only called when polling is on. */
  readonly startPoller: (intervalMs: number) => StoppablePoller;
  /**
   * How often the supervisor re-reads the stored answer, in ms. Deliberately
   * independent of the poll interval: the supervisor's job is to notice a
   * SETTING change, and an operator who has just set a one-hour interval should
   * not wait an hour for their next change to be noticed.
   */
  readonly superviseMs?: number;
  readonly log?: (message: string) => void;
  /**
   * Called with the decision in force on EVERY round, changed or not.
   *
   * The composition root prints the boot banner from the first call and a
   * transition line from every later one that differs — which is how an
   * operator who changed the setting in the panel verifies from the log that
   * their click took effect, on a server they have no shell on. Deciding what
   * is worth printing is the caller's job rather than this module's: the
   * supervisor knows what changed, the caller knows what the log should say.
   */
  readonly onDecision?: (decision: CommandIntakeDecision) => void;
}

/** How often the answer is re-read, when the caller names no interval. */
export const DEFAULT_SUPERVISE_MS = 30_000;

export interface CommandIntakeHandle {
  /** What the wizard reads through `GET /studio/command-intake`. */
  readonly status: CommandIntakeStatusReader;
  /** Stops the supervisor and any running poller. */
  readonly stop: () => void;
}

/**
 * Run the intake the operator asked for, and keep running the one they ask for
 * NEXT.
 *
 * The supervisor is the whole point of this function. `bin/bff.ts` reads
 * `JIRA_POLL_MS` once, at boot, and builds a poller or does not — so changing
 * the answer meant restarting the service, and a wizard that saved the setting
 * without saying so would leave an operator approving tickets into a void. Here
 * the answer is re-read on a timer and the poller is started, stopped or
 * re-intervalled to match, so `appliesLive` is `true` and the wizard can say so
 * truthfully.
 *
 * Restarting the poller on an interval change is deliberate and cheap: the
 * poller's own "already answered" memory is process-local and rebuilt on the
 * next round, and `decideGate` refuses a decision on a gate that is already
 * closed — so the worst case of re-reading a window of comments is a duplicate
 * refusal in the log, never a duplicate approval.
 */
export function startCommandIntake(options: CommandIntakeOptions): CommandIntakeHandle {
  const log = options.log ?? ((message: string) => console.log(message));
  const superviseMs = options.superviseMs ?? DEFAULT_SUPERVISE_MS;

  let stopped = false;
  let poller: StoppablePoller | null = null;
  /** The interval the running poller was started with, in seconds. */
  let runningSeconds = 0;
  let current: CommandIntakeDecision = resolveCommandIntake({}, options.envPollMs);

  const stopPoller = (): void => {
    poller?.stop();
    poller = null;
    runningSeconds = 0;
  };

  /**
   * Bring the running loop in line with the decision. Called on every round;
   * it does nothing at all when nothing changed, which is the common case.
   */
  const reconcile = (decision: CommandIntakeDecision): void => {
    current = decision;
    // Announced BEFORE the poller is touched, so the boot banner is the first
    // line in the log rather than the second — an operator reading a start-up
    // log top-down finds "what listening is configured" before "what it did".
    options.onDecision?.(decision);

    // A driver with no comment reader never polls, whatever is stored. Reported
    // to the operator through `canReadComments` on the status, and refused by
    // the wizard before it can be chosen.
    const wanted = intakePolls(decision.mode) && options.canReadComments ? decision.pollSeconds : 0;

    if (wanted === 0) {
      if (poller !== null) {
        stopPoller();
        log("[komut-alımı] yoklama kapatıldı (ayar değişti)");
      }
      return;
    }
    if (poller !== null && runningSeconds === wanted) return;

    if (poller !== null) stopPoller();
    poller = options.startPoller(wanted * 1000);
    runningSeconds = wanted;
    log(`[komut-alımı] yoklama açık (${wanted} sn, ${decision.mode})`);
  };

  const round = async (): Promise<void> => {
    if (stopped) return;
    let stored: StoredCommandIntake = {};
    try {
      stored = await options.readStored();
    } catch {
      // A parameter store that is briefly down must not tear down a working
      // poller: keep whatever is running and try again next round. Falling back
      // to "no stored value" here would silently revert an operator's answer to
      // the environment variable every time the database hiccuped.
      return;
    }
    if (stopped) return;
    reconcile(resolveCommandIntake(stored, options.envPollMs));
  };

  // The boot decision, applied immediately rather than one supervision interval
  // from now: an install whose answer is "poll" must poll from the first
  // second, not thirty seconds in.
  void round();

  const timer = setInterval(() => void round(), superviseMs);
  // Do not hold the process open for a supervision loop.
  timer.unref?.();

  return {
    status: () => ({
      mode: current.mode,
      // What is actually RUNNING, not what is stored: an answer of "poll" on a
      // driver that cannot read comments reports zero seconds, because zero is
      // the truth about what the loop is doing. `canReadComments` below is what
      // explains the discrepancy.
      pollSeconds: runningSeconds,
      canReadComments: options.canReadComments,
      // True by construction: this supervisor re-reads the stored answer on a
      // timer, so a change saved from the panel is picked up without a restart.
      appliesLive: true,
      source: current.source,
    }),
    stop: () => {
      stopped = true;
      clearInterval(timer);
      stopPoller();
    },
  };
}
