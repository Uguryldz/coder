import { IsoDateTime, NonEmpty } from "@maestro/contracts";
import { z } from "zod";

/**
 * Maestro Runner Agent protocol (M22) — MESSAGE SCHEMAS ONLY.
 *
 * Direction is the security property: mac/win runners dial OUT to Maestro over
 * gRPC/WebSocket and no port is ever opened towards a runner. This file
 * therefore contains no server, no socket and no listener; the transport lands
 * in Wave 3 and must keep the same direction. Replies are modelled as messages
 * the platform sends back down the connection the agent already opened.
 *
 * Direction is not identity, though. Anything that can reach the endpoint can
 * SAY it is `mac-mini-07`, so every registration carries a credential and the
 * platform verifies it (`agent-registry.ts`) — an unauthenticated `register`
 * that also displaced the previous session was a free way to take a real
 * machine's place in the pool.
 */

export const AGENT_PROTOCOL_VERSION = 1;

/** Platforms served by an agent. `docker-linux` handles the linux profiles (M21). */
export const AgentPlatform = z.enum(["macos-xcode", "windows-dotnet"]);
export type AgentPlatform = z.infer<typeof AgentPlatform>;

export const AgentId = z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/);

/**
 * Session id. Minted by the platform and used by the agent as a bearer
 * capability on every later message, so it must be unguessable: `randomUUID`
 * in production, and never derived from the agent id.
 */
export const SessionId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/);

/**
 * Shared secret proving the agent is the machine it claims to be. Long enough
 * that it cannot be guessed; it appears in NO reply, no session record and no
 * error message (see `AgentProtocolError` usage in the registry).
 */
export const AgentToken = z.string().min(24).max(512);

const LeaseIds = z.array(NonEmpty).max(64).default([]);

/** agent → platform: "I am here, this is what I can run." */
export const AgentRegister = z.object({
  type: z.literal("register"),
  protocolVersion: z.number().int(),
  agentId: AgentId,
  platform: AgentPlatform,
  agentVersion: NonEmpty,
  /** Free-form capability labels (xcode-16, vs2022, android-sdk-35…). */
  labels: z.array(z.string().regex(/^[a-z0-9][a-z0-9._-]*$/)).max(32).default([]),
  maxConcurrency: z.number().int().min(1).max(16),
  startedAt: IsoDateTime,
  authToken: AgentToken,
  /**
   * "I know another session of mine is live, replace it." A restart says this;
   * a stranger saying it still has to authenticate first, and the platform
   * answers with the leases the displaced session was holding so they can be
   * rescheduled instead of silently lost.
   */
  takeover: z.boolean().default(false),
});
export type AgentRegister = z.infer<typeof AgentRegister>;

/**
 * agent → platform: liveness + what it BELIEVES it holds. The list is a
 * declaration, not a fact: the platform keeps its own lease table and only
 * compares (see `AgentRegistry.heartbeat`).
 */
export const AgentHeartbeat = z.object({
  type: z.literal("heartbeat"),
  protocolVersion: z.number().int(),
  sessionId: SessionId,
  agentId: AgentId,
  at: IsoDateTime,
  activeLeases: LeaseIds,
  healthy: z.boolean(),
  /** Machine-readable reason when unhealthy; user-facing text lives in the catalog (M104). */
  reasonKey: NonEmpty.optional(),
});
export type AgentHeartbeat = z.infer<typeof AgentHeartbeat>;

/** agent → platform: orderly shutdown, so the slots free immediately. */
export const AgentBye = z.object({
  type: z.literal("bye"),
  protocolVersion: z.number().int(),
  sessionId: SessionId,
  agentId: AgentId,
  at: IsoDateTime,
  reasonKey: NonEmpty.optional(),
});
export type AgentBye = z.infer<typeof AgentBye>;

/** Everything an agent may say. Outbound only. */
export const AgentMessage = z.discriminatedUnion("type", [AgentRegister, AgentHeartbeat, AgentBye]);
export type AgentMessage = z.infer<typeof AgentMessage>;

export const RegisterAccepted = z.object({
  type: z.literal("register_accepted"),
  protocolVersion: z.number().int(),
  sessionId: SessionId,
  heartbeatIntervalSeconds: z.number().int().min(1).max(300),
  /** A lease the platform stops trusting if no heartbeat renews it. */
  leaseTtlSeconds: z.number().int().min(1).max(3_600),
  serverTime: IsoDateTime,
});
export type RegisterAccepted = z.infer<typeof RegisterAccepted>;

export const HeartbeatAck = z.object({
  type: z.literal("heartbeat_ack"),
  protocolVersion: z.number().int(),
  sessionId: SessionId,
  nextIntervalSeconds: z.number().int().min(1).max(300),
  /** Leases the agent must abandon (revoked, or unknown to the platform). */
  revokedLeases: LeaseIds,
  serverTime: IsoDateTime,
});
export type HeartbeatAck = z.infer<typeof HeartbeatAck>;

export const PlatformReply = z.discriminatedUnion("type", [RegisterAccepted, HeartbeatAck]);
export type PlatformReply = z.infer<typeof PlatformReply>;
