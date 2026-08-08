import { describe, expect, it } from "vitest";
import {
  AGENT_PROTOCOL_VERSION,
  AgentHeartbeat,
  AgentMessage,
  AgentRegister,
  AgentRegistry,
  HeartbeatAck,
  PlatformReply,
  RegisterAccepted,
} from "../src/agent-protocol.js";
import { AgentProtocolError } from "../src/errors.js";
import { fakeClock, sequentialIds } from "./helpers.js";

const REGISTER = {
  type: "register" as const,
  protocolVersion: AGENT_PROTOCOL_VERSION,
  agentId: "mac-mini-07",
  platform: "macos-xcode" as const,
  agentVersion: "0.1.0",
  labels: ["xcode-16", "ios-simulator"],
  maxConcurrency: 2,
  startedAt: "2026-08-08T14:00:00.000Z",
};

function registry(startIso?: string) {
  const clock = fakeClock(startIso);
  return {
    clock,
    agents: new AgentRegistry({ clock: clock.clock, newId: sequentialIds("session"), heartbeatIntervalSeconds: 10 }),
  };
}

function heartbeat(sessionId: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    type: "heartbeat",
    protocolVersion: AGENT_PROTOCOL_VERSION,
    sessionId,
    agentId: REGISTER.agentId,
    at: "2026-08-08T14:20:00.000Z",
    activeLeases: [],
    healthy: true,
    ...overrides,
  };
}

describe("message schemas", () => {
  it("accepts a well-formed registration and applies its defaults", () => {
    const parsed = AgentRegister.parse({ ...REGISTER, labels: undefined });

    expect(parsed.labels).toEqual([]);
    expect(AgentHeartbeat.parse(heartbeat("session-00000001")).activeLeases).toEqual([]);
  });

  it("refuses ids, platforms and concurrencies outside the grammar", () => {
    expect(AgentRegister.safeParse({ ...REGISTER, agentId: "MAC-01" }).success).toBe(false);
    expect(AgentRegister.safeParse({ ...REGISTER, platform: "linux-node" }).success).toBe(false);
    expect(AgentRegister.safeParse({ ...REGISTER, maxConcurrency: 0 }).success).toBe(false);
    expect(AgentRegister.safeParse({ ...REGISTER, startedAt: "yesterday" }).success).toBe(false);
  });

  it("bounds the lease list an agent may claim", () => {
    const many = Array.from({ length: 65 }, (_, index) => `lease-${index}`);

    expect(AgentHeartbeat.safeParse(heartbeat("session-00000001", { activeLeases: many })).success).toBe(false);
  });

  it("discriminates the agent→platform union by type, and rejects a foreign type", () => {
    expect(AgentMessage.parse(REGISTER).type).toBe("register");
    expect(AgentMessage.parse(heartbeat("session-00000001")).type).toBe("heartbeat");
    expect(AgentMessage.safeParse({ ...REGISTER, type: "job_result" }).success).toBe(false);
  });

  it("discriminates the platform→agent union the same way", () => {
    const reply = {
      type: "heartbeat_ack",
      protocolVersion: AGENT_PROTOCOL_VERSION,
      sessionId: "session-00000001",
      nextIntervalSeconds: 10,
      revokedLeases: [],
      serverTime: "2026-08-08T14:20:00.000Z",
    };

    expect(PlatformReply.parse(reply).type).toBe("heartbeat_ack");
    expect(PlatformReply.safeParse({ ...reply, type: "job_offer" }).success).toBe(false);
  });

  it("keeps user-facing text out of the wire format (M104)", () => {
    const fields = Object.keys(AgentHeartbeat.shape);

    expect(fields).toContain("reasonKey");
    expect(fields).not.toContain("reason");
    expect(fields).not.toContain("message");
  });
});

describe("registration (M22)", () => {
  it("accepts an agent and hands back a session with its heartbeat contract", () => {
    const { agents } = registry();

    const accepted = agents.register(REGISTER);

    expect(RegisterAccepted.parse(accepted)).toEqual(accepted);
    expect(accepted).toMatchObject({ sessionId: "session-00000001", heartbeatIntervalSeconds: 10 });
    expect(agents.sessions("macos-xcode")).toHaveLength(1);
  });

  it("replaces the previous session when the same agent registers again", () => {
    const { agents } = registry();
    const first = agents.register(REGISTER);

    const second = agents.register(REGISTER);

    expect(second.sessionId).not.toBe(first.sessionId);
    expect(agents.sessions()).toHaveLength(1);
    expect(() => agents.heartbeat(heartbeat(first.sessionId))).toThrow(AgentProtocolError);
  });

  it("refuses an unsupported protocol version instead of guessing the shape", () => {
    const { agents } = registry();

    expect(() => agents.register({ ...REGISTER, protocolVersion: 99 })).toThrow(/protocol version 99/);
  });

  it("refuses a malformed registration and names the offending field", () => {
    const { agents } = registry();

    expect(() => agents.register({ ...REGISTER, maxConcurrency: 99 })).toThrow(/maxConcurrency/);
  });
});

describe("heartbeat", () => {
  it("renews the session and echoes the interval", () => {
    const { agents } = registry();
    const accepted = agents.register(REGISTER);

    const ack = agents.heartbeat(heartbeat(accepted.sessionId, { activeLeases: ["lease-a"] }));

    expect(HeartbeatAck.parse(ack)).toEqual(ack);
    expect(ack.revokedLeases).toEqual([]);
    expect(agents.sessions()[0]?.activeLeases).toEqual(["lease-a"]);
  });

  it("uses the server clock, not the agent's, for liveness", () => {
    const { agents, clock } = registry("2026-08-08T14:20:00.000Z");
    const accepted = agents.register(REGISTER);
    clock.advance(5_000);

    agents.heartbeat(heartbeat(accepted.sessionId, { at: "2019-01-01T00:00:00.000Z" }));

    expect(agents.sessions()[0]?.lastSeenAt).toBe("2026-08-08T14:20:05.000Z");
  });

  it("reports the leases the agent silently dropped", () => {
    const { agents } = registry();
    const accepted = agents.register(REGISTER);
    agents.heartbeat(heartbeat(accepted.sessionId, { activeLeases: ["lease-a", "lease-b"] }));

    const ack = agents.heartbeat(heartbeat(accepted.sessionId, { activeLeases: ["lease-b"] }));

    expect(ack.revokedLeases).toEqual(["lease-a"]);
  });

  it("refuses a heartbeat for an unknown session", () => {
    const { agents } = registry();
    agents.register(REGISTER);

    expect(() => agents.heartbeat(heartbeat("session-99999999"))).toThrow(/unknown or expired/);
  });

  it("refuses a session id borrowed by another agent", () => {
    const { agents } = registry();
    const accepted = agents.register(REGISTER);

    expect(() => agents.heartbeat(heartbeat(accepted.sessionId, { agentId: "win-build-03" }))).toThrow(
      /another agent/,
    );
  });
});

describe("expiry — silence means gone (fail-closed)", () => {
  it("drops a session that missed the allowed number of beats", () => {
    const { agents, clock } = registry();
    agents.register(REGISTER);

    clock.advance(29_000);
    expect(agents.sessions()).toHaveLength(1);

    clock.advance(2_000);
    const stale = agents.expire();

    expect(stale).toHaveLength(1);
    expect(agents.sessions()).toHaveLength(0);
  });

  it("returns the leases of an expired session so they can be rescheduled", () => {
    const { agents, clock } = registry();
    const accepted = agents.register(REGISTER);
    agents.heartbeat(heartbeat(accepted.sessionId, { activeLeases: ["lease-a"] }));

    clock.advance(60_000);

    expect(agents.expire()[0]?.activeLeases).toEqual(["lease-a"]);
  });

  it("lets a heartbeat inside the window keep the session alive", () => {
    const { agents, clock } = registry();
    const accepted = agents.register(REGISTER);

    for (let beat = 0; beat < 5; beat += 1) {
      clock.advance(10_000);
      agents.heartbeat(heartbeat(accepted.sessionId));
    }

    expect(agents.sessions()).toHaveLength(1);
  });
});

describe("availability and shutdown", () => {
  it("hides unhealthy and fully-loaded agents from the available list", () => {
    const { agents } = registry();
    const accepted = agents.register(REGISTER);

    expect(agents.available("macos-xcode")).toHaveLength(1);

    agents.heartbeat(heartbeat(accepted.sessionId, { activeLeases: ["a", "b"] }));
    expect(agents.available("macos-xcode")).toHaveLength(0);

    agents.heartbeat(heartbeat(accepted.sessionId, { activeLeases: [], healthy: false, reasonKey: "disk_full" }));
    expect(agents.available("macos-xcode")).toHaveLength(0);
  });

  it("does not offer an agent of another platform", () => {
    const { agents } = registry();
    agents.register(REGISTER);

    expect(agents.available("windows-dotnet")).toHaveLength(0);
  });

  it("frees the leases of an agent that says goodbye", () => {
    const { agents } = registry();
    const accepted = agents.register(REGISTER);
    agents.heartbeat(heartbeat(accepted.sessionId, { activeLeases: ["lease-a"] }));

    const orphaned = agents.bye({
      type: "bye",
      protocolVersion: AGENT_PROTOCOL_VERSION,
      sessionId: accepted.sessionId,
      agentId: REGISTER.agentId,
      at: "2026-08-08T14:25:00.000Z",
    });

    expect(orphaned).toEqual(["lease-a"]);
    expect(agents.sessions()).toHaveLength(0);
  });

  it("refuses a goodbye for a session that is not the sender's", () => {
    const { agents } = registry();
    agents.register(REGISTER);

    expect(() =>
      agents.bye({
        type: "bye",
        protocolVersion: AGENT_PROTOCOL_VERSION,
        sessionId: "session-00000009",
        agentId: REGISTER.agentId,
        at: "2026-08-08T14:25:00.000Z",
      }),
    ).toThrow(AgentProtocolError);
  });
});
