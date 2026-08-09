import { IsoDateTime, NonEmpty } from "@maestro/contracts";
import { AGENT_PROTOCOL_VERSION, AgentId, SessionId } from "@maestro/runners";
import { z } from "zod";

/**
 * The messages the agent needs that `@maestro/runners/agent-protocol` (FROZEN)
 * does not yet carry: leased work pull, kill-switch delivery, log streaming.
 *
 * They live HERE, in the app, on purpose. The frozen package owns
 * register/heartbeat/bye and this file must not fork them — it imports them.
 * When the platform-side schemas land (see RAPOR.md "ARAYÜZ İSTEĞİ"), this
 * file is deleted and the imports move to `@maestro/runners`.
 *
 * Everything is still agent→platform request / platform→reply over the
 * connection the AGENT opened (M22): no shape here implies an inbound port.
 */

export { AGENT_PROTOCOL_VERSION, AgentId, SessionId };

/**
 * Kill-switch level as the agent sees it. Mirrors the two-level switch the BFF
 * operates (M58) plus the "nothing is stopped" state, which the BFF models as
 * the absence of a broadcast and the agent needs as an explicit value: a poll
 * reply has to be able to say "clear" as loudly as it says "stop".
 */
export const AgentKillLevel = z.enum(["off", "pause_intake", "stop_all"]);
export type AgentKillLevel = z.infer<typeof AgentKillLevel>;

/** Job the platform hands down. Mirrors `RunJob` plus the lease that carries it. */
export const LeasedJob = z.object({
  leaseId: NonEmpty,
  runId: NonEmpty,
  workspaceKey: NonEmpty,
  command: z.array(NonEmpty).min(1),
  timeoutSeconds: z.number().int().min(1),
  env: z.record(z.string(), z.string()).default({}),
  /** Absolute deadline; past it the platform may hand the job to someone else. */
  leaseExpiresAt: IsoDateTime,
});
export type LeasedJob = z.infer<typeof LeasedJob>;

/** agent → platform: "I have room for `max` jobs." Never more than free capacity. */
export const PullRequest = z.object({
  type: z.literal("pull"),
  protocolVersion: z.number().int(),
  sessionId: SessionId,
  agentId: AgentId,
  at: IsoDateTime,
  max: z.number().int().min(1).max(16),
});
export type PullRequest = z.infer<typeof PullRequest>;

/**
 * platform → agent: the jobs granted, and the kill-switch level in the SAME
 * reply. Bundling them is deliberate — a separate kill-switch poll can be the
 * one request that fails, and an agent that keeps pulling work because it
 * could not read the switch is exactly the failure M58 forbids.
 */
export const PullReply = z.object({
  type: z.literal("pull_reply"),
  protocolVersion: z.number().int(),
  sessionId: SessionId,
  jobs: z.array(LeasedJob).max(16).default([]),
  killLevel: AgentKillLevel,
  serverTime: IsoDateTime,
});
export type PullReply = z.infer<typeof PullReply>;

/** agent → platform: extend a lease that is still being worked on. */
export const LeaseRenew = z.object({
  type: z.literal("lease_renew"),
  protocolVersion: z.number().int(),
  sessionId: SessionId,
  agentId: AgentId,
  leaseId: NonEmpty,
  at: IsoDateTime,
});
export type LeaseRenew = z.infer<typeof LeaseRenew>;

/**
 * platform → agent: whether the lease is still the agent's, and the current
 * kill level. `granted: false` means STOP — the platform has given the job to
 * somebody else and a second executor would be a double-run.
 */
export const LeaseRenewReply = z.object({
  type: z.literal("lease_renew_reply"),
  protocolVersion: z.number().int(),
  leaseId: NonEmpty,
  granted: z.boolean(),
  leaseExpiresAt: IsoDateTime.optional(),
  killLevel: AgentKillLevel,
  serverTime: IsoDateTime,
});
export type LeaseRenewReply = z.infer<typeof LeaseRenewReply>;

/** Where one chunk of streamed output came from. */
export const LogStream = z.enum(["stdout", "stderr"]);
export type LogStream = z.infer<typeof LogStream>;

/**
 * agent → platform: one chunk of sandbox output. `text` is MASKED before this
 * object is built (see `masking.ts`); nothing on this path may carry a raw
 * secret, because the platform persists what it receives.
 */
export const LogChunk = z.object({
  type: z.literal("log_chunk"),
  protocolVersion: z.number().int(),
  sessionId: SessionId,
  agentId: AgentId,
  leaseId: NonEmpty,
  runId: NonEmpty,
  stream: LogStream,
  text: z.string(),
  at: IsoDateTime,
});
export type LogChunk = z.infer<typeof LogChunk>;

/** agent → platform: terminal outcome of a leased job; releases the lease. */
export const JobCompletion = z.object({
  type: z.literal("job_completed"),
  protocolVersion: z.number().int(),
  sessionId: SessionId,
  agentId: AgentId,
  leaseId: NonEmpty,
  runId: NonEmpty,
  outcome: z.enum(["succeeded", "failed", "cancelled", "abandoned"]),
  exitCode: z.number().int().optional(),
  durationMs: z.number().int().min(0),
  /** Message-catalog key (M104) — never a rendered sentence, never a payload. */
  reasonKey: NonEmpty.optional(),
  at: IsoDateTime,
});
export type JobCompletion = z.infer<typeof JobCompletion>;
