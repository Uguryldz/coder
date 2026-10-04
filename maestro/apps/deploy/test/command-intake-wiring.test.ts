import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The composition root actually WIRES the command-intake supervisor.
 *
 * `command-intake.ts` is fully tested on its own, and that is exactly what made
 * this failure possible: the module was green, the wizard saved the setting,
 * the status endpoint answered — and `bin/bff.ts` still read `JIRA_POLL_MS`
 * once at boot and ignored every one of them. An operator would choose "biz
 * Jira'ya soralım" in the panel, see it saved, and watch the gate wait forever.
 * Nothing failed; nothing was connected.
 *
 * A composition root cannot be unit-tested — it opens a database, a Temporal
 * connection and a socket — so this reads it as TEXT, the same discipline
 * `install-image-contract.test.ts` uses on the installer. It is a weak test by
 * design and it pins exactly one thing: that the connection is still there.
 */

function bffSource(): string {
  return readFileSync(fileURLToPath(new URL("../src/bin/bff.ts", import.meta.url)), "utf8");
}

describe("bin/bff.ts wires the command-intake supervisor", () => {
  it("starts the supervisor rather than reading JIRA_POLL_MS itself", () => {
    const source = bffSource();
    expect(source).toContain("startCommandIntake({");
    // The env variable is HANDED to the resolver, not branched on here: the
    // precedence (stored parameter → JIRA_POLL_MS → webhook-only) lives in one
    // tested place, and a second copy in the composition root is exactly how the
    // two would come to disagree.
    expect(source).toContain('envPollMs: env.source["JIRA_POLL_MS"]');
    expect(source).not.toMatch(/const pollMs = Number\(env\.source\["JIRA_POLL_MS"\]/);
  });

  /**
   * The server-side lock. A poller on a driver with no `listComments` throws
   * once per ticket per interval into a log nobody reads — which is the failure
   * the capability check exists to end, so the wizard's answer must not be able
   * to reintroduce it.
   */
  it("passes the comment-reading capability through as the poll lock", () => {
    expect(bffSource()).toContain("canReadComments: commentReader !== null");
  });

  /**
   * The wizard reads `GET /studio/command-intake`, which reads this. Wired
   * through a holder because `deps` is built before the supervisor exists — and
   * defaulting to the CONSERVATIVE answer, so an install where the supervisor
   * never started reports webhook-only rather than promising a poll.
   */
  it("reports the live status to the wizard through deps", () => {
    const source = bffSource();
    expect(source).toContain("commandIntakeStatus: () =>");
    expect(source).toContain("commandIntake.current?.status() ??");
  });

  /**
   * Lifecycle. The supervision timer and any running poller must stop with the
   * process: a round that starts during shutdown reaches a database that is
   * about to disconnect, and an unreferenced timer keeps handles open.
   */
  it("stops the supervisor on shutdown, before the socket closes", () => {
    const source = bffSource();
    const stop = source.indexOf("commandIntake.current?.stop();");
    const close = source.indexOf("await app.close();", stop);
    expect(stop).toBeGreaterThan(0);
    expect(close).toBeGreaterThan(stop);
  });

  /**
   * The boot banner and the live transition line — the two things an operator
   * with no shell on the server has to verify their setting from.
   */
  it("prints the listening banner and a line when the answer changes", () => {
    const source = bffSource();
    expect(source).toContain("listeningBannerLine(banner)");
    expect(source).toContain("listeningWarningLine(banner)");
    expect(source).toContain("[dinleme] komut alımı değişti:");
  });
});
