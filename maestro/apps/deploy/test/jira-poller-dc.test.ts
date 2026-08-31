import { JiraDcConfig, JiraDcWorkPort } from "@maestro/adapter-jira";
import type { ResolvedDeps } from "@maestro/bff";
import type { TicketKey } from "@maestro/contracts";
import { describe, expect, it } from "vitest";
import { canReadComments, startJiraPoller } from "../src/jira-poller.js";

/**
 * The Data Center fallback: reading `/approve` by POLLING when the webhook
 * cannot reach us.
 *
 * A Data Center inside a corporate network frequently has no outbound route to
 * Maestro. Its signed webhook is the primary command path and stays primary,
 * but when the delivery never arrives the documented way to pass a gate —
 * writing `/approve` on the ticket — reached nothing at all: the gate waited
 * forever and nobody could say why. These tests pin the fallback AND the two
 * properties that make it safe to run beside the webhook.
 */

const TICKET = "UGURPAY-501" as TicketKey;

function dcPort(): JiraDcWorkPort {
  return new JiraDcWorkPort({
    config: JiraDcConfig.parse({
      baseUrl: "https://jira.internal.bank",
      tokenRef: "kv/jira/pat",
      webhookSecretRef: "kv/jira/webhook",
    }),
    token: () => "pat-123",
    webhookSecret: () => "s",
    // The poller is handed its comments below; nothing in these tests may
    // reach the network, and a stray request fails loudly rather than hanging.
    fetchImpl: () => Promise.reject(new Error("unexpected network call")),
  });
}

/** A v2 comment resource in the shape the DC server serves it. */
function comment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "45201",
    author: { name: "mert.demir", key: "JIRAUSER10321", displayName: "Mert Demir", active: true },
    updateAuthor: { name: "mert.demir", key: "JIRAUSER10321" },
    body: "/approve",
    created: "2026-08-08T13:12:33.000+0300",
    updated: "2026-08-08T13:12:33.000+0300",
    ...overrides,
  };
}

/**
 * Run the poller for exactly one round over a fixed comment list, and report
 * every command that reached the handler.
 *
 * `handleCommand` consults the project BINDING before anything else and drops
 * an unbound project in silence (M102), so the recorder sits there: it observes
 * which comments became commands without needing a workflow engine, an audit
 * chain or a Jira behind them. That is precisely the question these tests ask.
 */
async function pollOnce(comments: unknown[]): Promise<string[]> {
  const handled: string[] = [];
  const deps = {
    bindings: {
      resolve: (projectKey: string) => {
        handled.push(projectKey);
        return Promise.resolve(null);
      },
    },
    counters: { droppedUnbound: 0 },
  } as unknown as ResolvedDeps;

  const driver = dcPort();
  const loop = startJiraPoller({
    deps,
    comments: {
      listComments: () => Promise.resolve(comments),
      // Exactly how the composition root wires it: the driver's own reader.
      parseCommandFromComment: (key, c) => driver.parseCommandFromComment(key, c),
    },
    openTickets: () => Promise.resolve([TICKET]),
    // Long enough that the interval never fires — the round below is the
    // immediate one `startJiraPoller` kicks off itself.
    intervalMs: 3_600_000,
    log: () => {},
  });

  await settle();
  loop.stop();
  return handled;
}

/** Let the poller's immediate round run to completion without a real timer. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

describe("jira poller on the Data Center driver", () => {
  /**
   * The gate this whole change turns on. It answered FALSE for DC —
   * `listComments` lived only on the Cloud driver — which is why an install
   * with `JIRA_POLL_MS` set still read no commands at all.
   */
  it("recognises the DC driver as a comment reader", () => {
    expect(canReadComments(dcPort())).toBe(true);
  });

  it("still refuses a driver that offers no thread to read", () => {
    expect(canReadComments({ getTicket: () => Promise.resolve({}) })).toBe(false);
    expect(canReadComments({ listComments: true })).toBe(false);
    expect(canReadComments(null)).toBe(false);
  });

  /**
   * The DC driver must parse its OWN comments. Cloud's parser reads `accountId`
   * and an ADF body; a DC comment has neither, so routing a DC thread through
   * it threw "comment has no identifiable author" on every single poll.
   */
  it("turns a v2 wiki-markup /approve into a handled command", async () => {
    expect(await pollOnce([comment()])).toEqual(["UGURPAY"]);
  });

  it("leaves an ordinary comment alone", async () => {
    expect(await pollOnce([comment({ body: "bakıyorum, yarın dönerim" })])).toEqual([]);
  });

  /**
   * K-2 THROUGH THE POLLER — the reason this path needed its own guard.
   *
   * "Edit All Comments" is a routine project-lead permission on DC: an edited
   * comment keeps the original `author` while a different `updateAuthor`
   * supplied the text. The webhook path refuses it, and the poller must not
   * become the way around it — otherwise a comment editor approves a gate AS
   * SOMEONE ELSE and walks straight past the SoD matrix.
   */
  it("produces NO command from an EDITED comment", async () => {
    const edited = comment({
      updateAuthor: { name: "proje.lideri", key: "JIRAUSER10999" },
      updated: "2026-08-08T13:41:12.000+0300",
    });
    expect(await pollOnce([edited])).toEqual([]);
  });

  /**
   * DOUBLE PROCESSING. The webhook and the poller can be on at once, and the
   * poller re-reads the whole thread every interval — one comment must never
   * become two decisions. The loop's `seen` set is keyed by
   * ticket+author+timestamp, so the same comment read twice is handled once.
   */
  it("handles the same comment once even when the thread carries it twice", async () => {
    expect(await pollOnce([comment(), comment()])).toEqual(["UGURPAY"]);
  });

  /**
   * The other half of that key: two DIFFERENT people approving is two real
   * decisions, not a repeat. De-duplication must not swallow the second one —
   * four-eyes depends on both reaching the gate.
   */
  it("still handles a second approval from a different person", async () => {
    const second = comment({
      id: "45202",
      author: { name: "ayse.kaya", key: "JIRAUSER10444" },
      updateAuthor: { name: "ayse.kaya", key: "JIRAUSER10444" },
      created: "2026-08-08T13:22:00.000+0300",
      updated: "2026-08-08T13:22:00.000+0300",
    });
    expect(await pollOnce([comment(), second])).toEqual(["UGURPAY", "UGURPAY"]);
  });
});
