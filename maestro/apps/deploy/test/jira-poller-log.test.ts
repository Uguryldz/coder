import { JiraDcConfig, JiraDcWorkPort } from "@maestro/adapter-jira";
import type { ResolvedDeps } from "@maestro/bff";
import type { TicketKey } from "@maestro/contracts";
import { describe, expect, it } from "vitest";
import { startJiraPoller } from "../src/jira-poller.js";
import {
  intakeLabel,
  listeningBannerLine,
  listeningWarningLine,
} from "../src/listening-banner.js";

/**
 * What the poller SAYS, and what it must never say.
 *
 * The loop used to log nothing at all. An operator whose `/approve` was never
 * honoured had four possible causes — the poller is not running, Jira is
 * unreachable, the comment was refused, the gate was already closed — and one
 * piece of evidence: silence. Every test here pins a line the operator needs,
 * and the last one pins the promise that makes the lines safe to ask for: no
 * PAT, no webhook secret, no comment body.
 */

const TICKET = "UGURPAY-501" as TicketKey;
const PAT = "pat-super-secret-123";

function dcPort(): JiraDcWorkPort {
  return new JiraDcWorkPort({
    config: JiraDcConfig.parse({
      baseUrl: "https://jira.internal.bank",
      tokenRef: "kv/jira/pat",
      webhookSecretRef: "kv/jira/webhook",
    }),
    token: () => PAT,
    webhookSecret: () => "webhook-super-secret-456",
    // Nothing in these tests may reach the network; a stray call fails loudly.
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

interface RoundOptions {
  readonly comments?: unknown[];
  /** Throws instead of answering — Jira unreachable, 401, an unknown shape. */
  readonly listThrows?: Error;
  readonly tickets?: readonly TicketKey[];
}

/** Run exactly one round and return every line it logged. */
async function roundLines(options: RoundOptions = {}): Promise<string[]> {
  const lines: string[] = [];
  const deps = {
    // `handleCommand` consults the binding first and drops an unbound project
    // in silence (M102); answering null here keeps the round free of a workflow
    // engine while still exercising the whole command path.
    bindings: { resolve: () => Promise.resolve(null) },
    counters: { droppedUnbound: 0 },
  } as unknown as ResolvedDeps;

  const driver = dcPort();
  const loop = startJiraPoller({
    deps,
    comments: {
      listComments: () =>
        options.listThrows === undefined
          ? Promise.resolve(options.comments ?? [])
          : Promise.reject(options.listThrows),
      parseCommandFromComment: (key, c) => driver.parseCommandFromComment(key, c),
    },
    openTickets: () => Promise.resolve(options.tickets ?? [TICKET]),
    // Long enough that the interval never fires — the round asserted on is the
    // immediate one `startJiraPoller` kicks off itself.
    intervalMs: 3_600_000,
    log: (message) => lines.push(message),
  });

  await settle();
  loop.stop();
  return lines;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

const summaryOf = (lines: string[]): string =>
  lines.find((line) => line.startsWith("[yoklama] tur bitti")) ?? "";

describe("the poller says what it did", () => {
  /**
   * The EMPTY round is the important one.
   *
   * "The poller is running and nobody has approved anything" and "the poller is
   * not running at all" are the two states an operator with a stuck gate has to
   * tell apart. Without this line they are the same evidence: nothing.
   */
  it("prints a round summary even when nothing was found", async () => {
    const summary = summaryOf(await roundLines({ comments: [] }));
    expect(summary).toContain("1 ticket");
    expect(summary).toContain("0 yorum");
    expect(summary).toContain("0 komut");
  });

  it("counts the comments it read and the commands it honoured", async () => {
    const summary = summaryOf(
      await roundLines({
        comments: [comment(), comment({ id: "2", body: "bakıyorum, yarın dönerim" })],
      }),
    );
    expect(summary).toContain("2 yorum");
    expect(summary).toContain("1 komut");
  });

  /**
   * ONE line per round, not one per ticket. At a 60-second interval a per-ticket
   * line is thousands of lines a day, and a log nobody can read is the same as
   * no log at all.
   */
  it("prints ONE summary for a round over many tickets, not one per ticket", async () => {
    const tickets = ["UGURPAY-1", "UGURPAY-2", "UGURPAY-3", "UGURPAY-4"] as TicketKey[];
    const lines = await roundLines({ comments: [], tickets });
    expect(lines.filter((line) => line.startsWith("[yoklama] tur bitti"))).toHaveLength(1);
    expect(summaryOf(lines)).toContain("4 ticket");
  });

  /**
   * The SECURITY refusal, named rather than swallowed.
   *
   * A comment with no `updated` timestamp cannot PROVE it was never edited, and
   * an edited comment must never carry a command: on Jira DC "Edit All
   * Comments" is a routine project-lead permission, so honouring one would let
   * its holder approve a gate AS SOMEONE ELSE (M32/M51). The parser refuses it;
   * this is the line that tells the approver why their `/approve` did nothing.
   */
  it("names the edited-comment refusal and its reason", async () => {
    const lines = await roundLines({ comments: [comment({ updated: undefined })] });
    const refusal = lines.find((line) => line.includes("görevler ayrılığı"));
    expect(refusal).toBeDefined();
    expect(refusal).toContain(TICKET);
    expect(summaryOf(lines)).toContain("1 düzenlenmiş yorum reddedildi");
  });

  /**
   * An `/approve` already answered in an earlier round is NOT a failure — it is
   * the de-dupe memory working. It is counted so a puzzled operator can see the
   * comment was read, and separated from the failures so it does not look like
   * one.
   */
  it("counts an already-answered comment as a duplicate, not a failure", async () => {
    const lines: string[] = [];
    const deps = {
      bindings: { resolve: () => Promise.resolve(null) },
      counters: { droppedUnbound: 0 },
    } as unknown as ResolvedDeps;
    const driver = dcPort();
    const loop = startJiraPoller({
      deps,
      comments: {
        listComments: () => Promise.resolve([comment()]),
        parseCommandFromComment: (key, c) => driver.parseCommandFromComment(key, c),
      },
      openTickets: () => Promise.resolve([TICKET]),
      // Two rounds inside the test's lifetime: the immediate one and one timer.
      intervalMs: 5,
      log: (message) => lines.push(message),
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    loop.stop();

    const summaries = lines.filter((line) => line.startsWith("[yoklama] tur bitti"));
    expect(summaries.length).toBeGreaterThanOrEqual(2);
    expect(summaries.slice(1).some((line) => line.includes("zaten görülmüş"))).toBe(true);
  });

  /**
   * Jira unreachable, or refusing. The operator has to be able to tell this from
   * "the comment was read and ignored", and the two look identical without a
   * line naming the ticket and the driver's own message.
   */
  it("names a ticket whose read failed, and counts it in the summary", async () => {
    const lines = await roundLines({ listThrows: new Error("401 Unauthorized") });
    const failure = lines.find((line) => line.includes("okunamadı"));
    expect(failure).toContain(TICKET);
    expect(failure).toContain("401 Unauthorized");
    expect(summaryOf(lines)).toContain("1 ticket okunamadı");
  });

  /**
   * A Jira outage must not fill the log. The count is the fact; the first few
   * failures are the story (a wrong PAT answers 401 for every ticket alike).
   */
  it("caps per-ticket failure lines while still counting every failure", async () => {
    const tickets = Array.from({ length: 12 }, (_, i) => `UGURPAY-${i + 1}` as TicketKey);
    const lines = await roundLines({ listThrows: new Error("ECONNREFUSED"), tickets });
    const named = lines.filter((line) => line.includes("okunamadı") && !line.includes("tur bitti"));
    expect(named.length).toBeLessThanOrEqual(3);
    expect(summaryOf(lines)).toContain("12 ticket okunamadı");
  });

  /**
   * THE PROMISE that makes every line above safe to ask a bank for.
   *
   * These are the lines an operator pastes into a ticket when listening does
   * not work. Not one of them may carry the PAT, the webhook secret or the
   * comment BODY — a comment in a bank routinely names a person, an account or
   * an amount. A `/reject` reason is the sharpest case: it is free text, and it
   * belongs in the audit chain rather than in a log aggregator.
   */
  it("leaks no PAT, no webhook secret and no comment body", async () => {
    const lines = await roundLines({
      comments: [
        comment({ body: "/reject IBAN TR33 0006 1005 1978 6457 8413 26 yanlış" }),
        comment({ id: "3", body: "kart no 4111 1111 1111 1111 kontrol edilecek" }),
      ],
    });
    const all = lines.join("\n");
    expect(all).not.toContain(PAT);
    expect(all).not.toContain("webhook-super-secret-456");
    expect(all).not.toContain("TR33 0006 1005 1978 6457 8413 26");
    expect(all).not.toContain("4111 1111 1111 1111");
    // The ticket key and the command name DO appear — a line without them would
    // be useless to the operator it is written for.
    expect(all).toContain(TICKET);
    expect(all).toContain("reject");
  });

  /**
   * An author that is an e-mail address is masked.
   *
   * `userIdOf` falls back to `emailAddress` when a DC user carries neither
   * `name` nor `key`, so the identity CAN be personal data — which the platform
   * masks everywhere else (`packages/pii`).
   */
  it("masks an author that is an e-mail address", async () => {
    const lines = await roundLines({
      comments: [comment({ author: { emailAddress: "mert.demir@banka.com.tr" } })],
    });
    const all = lines.join("\n");
    expect(all).not.toContain("mert.demir@banka.com.tr");
    expect(all).toContain("@banka.com.tr");
  });
});

/**
 * The BOOT BANNER — the first line to ask an operator for.
 *
 * It answers, in one pasteable line: which driver is installed, where Jira has
 * to deliver, what is in force, where that answer came from, and whether the
 * driver can read a comment at all.
 */
describe("the listening banner", () => {
  const base = {
    driver: "jira-dc",
    canReadComments: true,
    webhookPath: "/webhooks/jira",
  };

  it("names driver, endpoint, mode, source and comment-reading in one line", () => {
    const line = listeningBannerLine({
      ...base,
      intake: { mode: "both", pollSeconds: 60, source: "param" },
    });
    expect(line).toContain("sürücü=jira-dc");
    expect(line).toContain("webhook=/webhooks/jira");
    expect(line).toContain("webhook + yoklama (60 sn)");
    expect(line).toContain("kaynak=panel ayarı");
    expect(line).toContain("yorum-okuma=var");
    // One line, so it survives being copied out of a container log.
    expect(line.split("\n")).toHaveLength(1);
  });

  it("distinguishes the three sources an operator would chase differently", () => {
    const of = (source: "param" | "env" | "default"): string =>
      listeningBannerLine({ ...base, intake: { mode: "poll", pollSeconds: 60, source } });
    expect(of("param")).toContain("panel ayarı");
    expect(of("env")).toContain("JIRA_POLL_MS");
    expect(of("default")).toContain("varsayılan");
  });

  /**
   * The loudest case: a driver that cannot read a comment at all. The banner
   * states the fact; the warning states the consequence, because an operator
   * reading `yorum-okuma=YOK` should not have to work out what it implies
   * about `/approve`.
   */
  it("warns, in words, when the driver cannot read comments", () => {
    const banner = {
      ...base,
      canReadComments: false,
      intake: { mode: "poll" as const, pollSeconds: 60, source: "param" as const },
    };
    expect(listeningBannerLine(banner)).toContain("yorum-okuma=YOK");
    const warning = listeningWarningLine(banner);
    expect(warning).toContain("/approve");
    expect(warning).toContain("yoklama açılamaz");
  });

  /** Webhook-only is legitimate — and still worth a sentence, because it is the
   * configuration in which a firewalled Jira reads nothing at all. */
  it("warns that a webhook-only install reads nothing if Jira cannot reach us", () => {
    const warning = listeningWarningLine({
      ...base,
      intake: { mode: "webhook", pollSeconds: 0, source: "default" },
    });
    expect(warning).toContain("Yoklama KAPALI");
  });

  it("says nothing extra when polling is on and possible", () => {
    expect(
      listeningWarningLine({
        ...base,
        intake: { mode: "both", pollSeconds: 60, source: "param" },
      }),
    ).toBeNull();
  });

  it("spells the interval into the mode label", () => {
    expect(intakeLabel({ mode: "poll", pollSeconds: 30, source: "param" })).toBe(
      "yalnız yoklama (30 sn)",
    );
    expect(intakeLabel({ mode: "webhook", pollSeconds: 0, source: "default" })).toBe(
      "yalnız webhook",
    );
  });

  /** No credential belongs on the line an operator is asked to paste publicly. */
  it("carries no credential", () => {
    const line = listeningBannerLine({
      ...base,
      intake: { mode: "both", pollSeconds: 60, source: "env" },
    });
    expect(line).not.toContain("://");
    expect(line.toLowerCase()).not.toContain("token");
    expect(line.toLowerCase()).not.toContain("secret");
    expect(line.toLowerCase()).not.toContain("authorization");
  });
});
