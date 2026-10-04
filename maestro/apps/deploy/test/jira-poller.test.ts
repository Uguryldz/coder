import { describe, expect, it } from "vitest";
import { canReadComments } from "../src/jira-poller.js";

/**
 * Which drivers can read a comment thread.
 *
 * The composition root used to hand the poller `ports.work as unknown as
 * { listComments(...) }` — a cast TypeScript accepts and the runtime does not.
 * `listComments` is a DRIVER-specific capability, not a `WorkPort` method:
 * both Jira drivers offer it (Cloud REST v3, Data Center REST v2 — see
 * `jira-poller-dc.test.ts`), and Azure DevOps has no work port at all.
 *
 * The consequence is the one a bank feels first. `/approve` written on the
 * ticket is the documented way to pass a gate; with no comment reader it is
 * never seen, so the gate waits forever and the run looks stuck for no reason
 * anybody can point at. The per-ticket catch made it worse, not better: the
 * error was logged once per ticket per interval and never explained.
 */
describe("canReadComments", () => {
  it("accepts a driver that really offers the reader", () => {
    expect(canReadComments({ listComments: () => Promise.resolve([]) })).toBe(true);
  });

  /**
   * A work driver that writes comments but cannot read them. This used to be
   * the Data Center port's exact shape; DC reads a thread now, so the case
   * survives as the general one — a driver may still arrive without it, and
   * the check must stay a real check rather than a cast.
   */
  it("rejects a work driver that cannot read comments", () => {
    const dcWorkPort = {
      getTicket: () => Promise.resolve({}),
      addComment: () => Promise.resolve({ commentId: "1" }),
      updateComment: () => Promise.resolve(),
      transition: () => Promise.resolve(),
    };

    expect(canReadComments(dcWorkPort)).toBe(false);
  });

  /**
   * A property that merely EXISTS is what the old cast effectively assumed;
   * calling a non-function throws the very error this check exists to prevent.
   */
  it("rejects a driver whose listComments is not callable", () => {
    expect(canReadComments({ listComments: true })).toBe(false);
  });

  it("rejects nothing at all rather than throwing on it", () => {
    expect(canReadComments(null)).toBe(false);
    expect(canReadComments(undefined)).toBe(false);
  });
});
