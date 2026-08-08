import { IsoDateTime, NonEmpty } from "@maestro/contracts";
import { z } from "zod";
import type { Clock, IdSource } from "./deps.js";
import { AgentProtocolError } from "./errors.js";

/**
 * Maestro Runner Agent protocol (M22) — SCHEMAS AND STATE ONLY.
 *
 * Direction is the security property: mac/win runners dial OUT to Maestro over
 * gRPC/WebSocket and no port is ever opened towards a runner. This file
 * therefore contains no server, no socket and no listener; the transport lands
 * in Wave 3 and must keep the same direction. Replies are modelled as messages
 * the platform sends back down the connection the agent already opened.
 */

export const AGENT_PROTOCOL_VERSION = 1;

/** Platforms served by an agent. `docker-linux` handles the linux profiles (M21). */
export const AgentPlatform = z.enum(["macos-xcode", "windows-dotnet"]);
export type AgentPlatform = z.infer<typeof AgentPlatform>;

export const AgentId = z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/);
export const SessionId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/);

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
});
export type AgentRegister = z.infer<typeof AgentRegister>;

/** agent → platform: liveness + what it currently holds. */
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

export interface AgentSession {
  sessionId: string;
  agentId: string;
  platform: AgentPlatform;
  agentVersion: string;
  labels: string[];
  maxConcurrency: number;
  registeredAt: string;
  /** Server-side timestamp — the agent's own clock is never trusted for liveness. */
  lastSeenAt: string;
  activeLeases: string[];
  healthy: boolean;
}

export interface AgentRegistryOptions {
  clock: Clock;
  newId: IdSource;
  heartbeatIntervalSeconds?: number;
  /** Missed beats before a session is considered gone (default 3). */
  missedBeatsBeforeStale?: number;
  leaseTtlSeconds?: number;
}

const DEFAULT_HEARTBEAT_SECONDS = 15;
const DEFAULT_MISSED_BEATS = 3;
const DEFAULT_LEASE_TTL_SECONDS = 300;

/**
 * In-memory registration + heartbeat state for outbound agents. Wave 3 wires a
 * transport to it; the rules — one live session per agent, no trust in the
 * agent's clock, a stale session loses its leases — are decided here so they
 * can be tested without one.
 */
export class AgentRegistry {
  readonly #sessions = new Map<string, AgentSession>();
  readonly #byAgent = new Map<string, string>();
  readonly #clock: Clock;
  readonly #newId: IdSource;
  readonly #intervalSeconds: number;
  readonly #missedBeats: number;
  readonly #leaseTtlSeconds: number;

  constructor(options: AgentRegistryOptions) {
    this.#clock = options.clock;
    this.#newId = options.newId;
    this.#intervalSeconds = options.heartbeatIntervalSeconds ?? DEFAULT_HEARTBEAT_SECONDS;
    this.#missedBeats = options.missedBeatsBeforeStale ?? DEFAULT_MISSED_BEATS;
    this.#leaseTtlSeconds = options.leaseTtlSeconds ?? DEFAULT_LEASE_TTL_SECONDS;
  }

  /**
   * Registers (or re-registers) an agent. A second daemon on the same machine
   * REPLACES the first: two live sessions for one agent id would double-count
   * its capacity and let a zombie process keep leases alive.
   */
  register(message: unknown): RegisterAccepted {
    const parsed = this.#parse(AgentRegister, message);
    const previous = this.#byAgent.get(parsed.agentId);
    if (previous !== undefined) this.#sessions.delete(previous);

    const sessionId = SessionId.parse(this.#newId());
    const now = this.#clock().toISOString();
    this.#sessions.set(sessionId, {
      sessionId,
      agentId: parsed.agentId,
      platform: parsed.platform,
      agentVersion: parsed.agentVersion,
      labels: parsed.labels,
      maxConcurrency: parsed.maxConcurrency,
      registeredAt: now,
      lastSeenAt: now,
      activeLeases: [],
      healthy: true,
    });
    this.#byAgent.set(parsed.agentId, sessionId);

    return RegisterAccepted.parse({
      type: "register_accepted",
      protocolVersion: AGENT_PROTOCOL_VERSION,
      sessionId,
      heartbeatIntervalSeconds: this.#intervalSeconds,
      leaseTtlSeconds: this.#leaseTtlSeconds,
      serverTime: now,
    });
  }

  /** Renews a session. An unknown, replaced or already-expired session is refused. */
  heartbeat(message: unknown): HeartbeatAck {
    const parsed = this.#parse(AgentHeartbeat, message);
    this.expire();
    const session = this.#sessions.get(parsed.sessionId);
    if (session === undefined) throw new AgentProtocolError(parsed.agentId, "session is unknown or expired");
    if (session.agentId !== parsed.agentId) {
      throw new AgentProtocolError(parsed.agentId, "session belongs to another agent");
    }

    const revokedLeases = session.activeLeases.filter((lease) => !parsed.activeLeases.includes(lease));
    session.activeLeases = [...parsed.activeLeases];
    session.healthy = parsed.healthy;
    session.lastSeenAt = this.#clock().toISOString();

    return HeartbeatAck.parse({
      type: "heartbeat_ack",
      protocolVersion: AGENT_PROTOCOL_VERSION,
      sessionId: session.sessionId,
      nextIntervalSeconds: this.#intervalSeconds,
      revokedLeases,
      serverTime: session.lastSeenAt,
    });
  }

  /** Orderly disconnect. Returns the leases the platform must reschedule. */
  bye(message: unknown): string[] {
    const parsed = this.#parse(AgentBye, message);
    const session = this.#sessions.get(parsed.sessionId);
    if (session === undefined || session.agentId !== parsed.agentId) {
      throw new AgentProtocolError(parsed.agentId, "session is unknown or expired");
    }
    this.#sessions.delete(session.sessionId);
    if (this.#byAgent.get(session.agentId) === session.sessionId) this.#byAgent.delete(session.agentId);
    return [...session.activeLeases];
  }

  /**
   * Drops sessions that missed too many heartbeats and returns them, so the
   * caller can reschedule their leases. Silence means gone (fail-closed): a
   * disconnected Mac mini must not keep a ticket's slot forever.
   */
  expire(): AgentSession[] {
    const deadline = this.#clock().getTime() - this.#intervalSeconds * this.#missedBeats * 1_000;
    const stale = [...this.#sessions.values()].filter((session) => Date.parse(session.lastSeenAt) < deadline);
    for (const session of stale) {
      this.#sessions.delete(session.sessionId);
      if (this.#byAgent.get(session.agentId) === session.sessionId) this.#byAgent.delete(session.agentId);
    }
    return stale;
  }

  /** Live sessions, optionally for one platform. Expired ones are swept first. */
  sessions(platform?: AgentPlatform): AgentSession[] {
    this.expire();
    const all = [...this.#sessions.values()];
    return platform === undefined ? all : all.filter((session) => session.platform === platform);
  }

  /** Sessions that can take work right now: alive, healthy, below concurrency. */
  available(platform: AgentPlatform): AgentSession[] {
    return this.sessions(platform).filter(
      (session) => session.healthy && session.activeLeases.length < session.maxConcurrency,
    );
  }

  #parse<T extends { agentId: string; protocolVersion: number }>(schema: z.ZodType<T>, message: unknown): T {
    const result = schema.safeParse(message);
    if (!result.success) {
      const issues = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
      const agentId = (message as { agentId?: unknown } | null)?.agentId;
      throw new AgentProtocolError(typeof agentId === "string" ? agentId : "(unknown)", issues);
    }
    if (result.data.protocolVersion !== AGENT_PROTOCOL_VERSION) {
      throw new AgentProtocolError(
        result.data.agentId,
        `protocol version ${result.data.protocolVersion} is not supported (expected ${AGENT_PROTOCOL_VERSION})`,
      );
    }
    return result.data;
  }
}
