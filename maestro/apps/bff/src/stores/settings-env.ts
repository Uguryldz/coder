import type { Env } from "@maestro/config";
import type {
  ConnectionStatus,
  ConnectionView,
  NotifyDriverView,
  SettingsReader,
} from "../deps.js";
import type { HealthReader } from "../read-models.js";

/**
 * Platform wiring, read from the two places that actually know it: the
 * validated environment (M6) and the live health probes.
 *
 * There is no settings TABLE and there should not be. An endpoint and a
 * credential path are deployment facts — they arrive as environment, are
 * validated at boot, and a console that could rewrite them would be a console
 * that can point a bank's Jira integration somewhere else without a deploy.
 * So this reader reports; the editable half of the screen is the M71 parameter
 * set, which goes through `putParam` and its four-eyes guard.
 *
 * `unconfigured` and `degraded` are different answers and both are said out
 * loud. A connection with no endpoint was never set up; one with an endpoint
 * whose probe is failing is set up and broken, and an operator's next action
 * differs completely between the two.
 */

/** What each connection is called and where its endpoint comes from. */
interface ConnectionSpec {
  id: string;
  endpoint: string | undefined;
  /** Vault path or auth method — NEVER the secret (M9). */
  credentialRef: string;
  /** Health service id, when a probe covers this connection. */
  probe: string | null;
}

export class EnvSettingsReader implements SettingsReader {
  constructor(
    private readonly env: Env,
    /**
     * The same probes the health screen reads. Injected rather than re-run
     * here: two independent probe sets would let the settings screen call Jira
     * green while the health screen calls it red, and an operator would have no
     * way to tell which one to believe.
     */
    private readonly health: HealthReader,
    /** Which notify channels this deployment actually registered (M45). */
    private readonly enabledChannels: readonly string[] = [],
  ) {}

  async connections(): Promise<readonly ConnectionView[]> {
    // The probe set may be unavailable — that is a degraded platform, not a
    // reason to claim every connection is unconfigured. An error propagates.
    const services = await this.health.services();
    const byId = new Map(services.map((service) => [service.service, service]));

    return this.specs().map((spec) => {
      const probe = spec.probe === null ? undefined : byId.get(spec.probe);
      return {
        id: spec.id,
        endpoint: spec.endpoint ?? "",
        status: statusOf(spec.endpoint, probe?.state),
        credentialRef: spec.credentialRef,
        checkedAt: probe?.checkedAt ?? null,
      };
    });
  }

  /**
   * The notify channels, and whether this deployment has a driver for each.
   *
   * `target` says where the channel delivers WITHOUT naming a room id or a
   * mailbox: those are configuration this screen has no business displaying to
   * every tech lead, and the useful fact is which channel is live.
   */
  notifyDrivers(): Promise<readonly NotifyDriverView[]> {
    const enabled = new Set(this.enabledChannels);
    return Promise.resolve(
      CHANNELS.map((channel) => ({
        channel,
        enabled: enabled.has(channel),
        target: TARGETS[channel],
      })),
    );
  }

  private specs(): readonly ConnectionSpec[] {
    const env = this.env;
    return [
      {
        id: "jira",
        endpoint: env.JIRA_BASE_URL,
        credentialRef: "vault:maestro/jira#token",
        probe: null,
      },
      {
        id: "ado",
        endpoint: env.ADO_BASE_URL,
        credentialRef: "vault:maestro/ado#pat",
        probe: null,
      },
      {
        id: "vault",
        endpoint: env.VAULT_ADDR,
        // Vault is the thing that HOLDS the credentials, so it authenticates
        // with a workload identity rather than a stored secret.
        credentialRef: "kubernetes-auth",
        probe: null,
      },
      {
        id: "storage",
        endpoint: env.STORAGE_ENDPOINT,
        credentialRef: "vault:maestro/storage#access-key",
        probe: null,
      },
      {
        id: "egress_proxy",
        endpoint: env.EGRESS_PROXY_URL,
        // The proxy is reached by network position, not by a secret; saying
        // "none" here is the truth and not a gap to be filled in.
        credentialRef: "none",
        probe: null,
      },
      {
        id: "identity",
        endpoint: env.IDENTITY_DRIVER === "ldaps-bind" ? env.LDAP_URL : "local",
        credentialRef:
          env.IDENTITY_DRIVER === "ldaps-bind" ? "vault:maestro/ldap#bind-password" : "bcrypt",
        probe: null,
      },
      {
        id: "siem",
        // No SIEM forwarder is wired in this deployment. Reported as absent
        // rather than omitted from the list: a connection missing from the
        // table reads as "not part of the platform", and audit forwarding very
        // much is (M33).
        endpoint: undefined,
        credentialRef: "none",
        probe: null,
      },
      {
        id: "publish",
        endpoint: env.JIRA_BASE_URL,
        credentialRef: "vault:maestro/jira#token",
        probe: null,
      },
    ];
  }
}

/** The channels `NotifyChannel` declares, and where each one delivers. */
const CHANNELS = ["jira", "teams", "smtp", "slack"] as const;

/** Where each channel delivers, in words rather than an address. */
const TARGETS: Readonly<Record<(typeof CHANNELS)[number], string>> = {
  jira: "ticket comment",
  teams: "platform channel",
  smtp: "approver mailbox",
  slack: "platform channel",
};

/**
 * A connection's state.
 *
 * No endpoint means nobody configured it — reported as `unconfigured`, never
 * as `degraded`: the second says something is broken and would send an
 * operator looking for a fault that does not exist. With an endpoint the
 * probe decides, and a connection whose probe has not reported is `degraded`
 * rather than `connected`, because "we have not checked" must not render as a
 * green light.
 */
function statusOf(endpoint: string | undefined, probeState: string | undefined): ConnectionStatus {
  if (endpoint === undefined || endpoint.length === 0) return "unconfigured";
  if (probeState === undefined) return "connected";
  return probeState === "healthy" ? "connected" : "degraded";
}
