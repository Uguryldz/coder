import { CiResultSignal } from "@maestro/contracts";
import { describe, expect, it } from "vitest";
import { AdoCiDriver, AdoResponseError, parseBuildCompleteEvent } from "../src/index.js";
import { fixture } from "./helpers.js";

/** Deep-clones a fixture so a variant cannot leak into another test. */
function variant(name: string, patch: (resource: Record<string, unknown>) => void): unknown {
  const event = structuredClone(fixture(name)) as { resource: Record<string, unknown> };
  patch(event.resource);
  return event;
}

describe("AdoCiDriver.parseBuildEvent (M12 passive CI)", () => {
  it("maps a Services build.complete for a PR validation build", async () => {
    const signal = await new AdoCiDriver().parseBuildEvent(fixture("event-build-complete-services"));

    expect(signal).toEqual({
      ticketKey: "UGURPAY-4312",
      prId: 128,
      buildId: 4711,
      status: "succeeded",
      detailsUrl: "https://dev.azure.com/ugurbank/UgurPay/_build/results?buildId=4711",
      finishedAt: "2026-08-08T10:14:22.710Z",
    });
    expect(CiResultSignal.safeParse(signal).success).toBe(true);
  });

  it("maps an on-prem Server build.complete the same way", async () => {
    const signal = await new AdoCiDriver().parseBuildEvent(fixture("event-build-complete-server"));

    expect(signal).toMatchObject({
      ticketKey: "UGURWEB-902",
      prId: 77,
      buildId: 20261,
      status: "failed",
      finishedAt: "2026-08-08T07:49:05.880Z",
    });
    expect(signal?.detailsUrl).toContain("tfs.ugurbank.local");
  });

  it("returns null for a non-build event", async () => {
    await expect(new AdoCiDriver().parseBuildEvent(fixture("event-git-push"))).resolves.toBeNull();
  });

  it("returns null for a branch CI build with no pull request", async () => {
    expect(parseBuildCompleteEvent(fixture("event-build-complete-branch-ci"))).toBeNull();
  });

  it("returns null when the source branch carries no ticket key (M49)", async () => {
    // A PR validation build on refs/heads/hotfix/... — guessing a key here
    // would signal an unrelated workflow run, so the event is ignored.
    expect(parseBuildCompleteEvent(fixture("event-build-complete-no-ticket"))).toBeNull();
  });

  it("returns null for a body that is not a Service Hook envelope", () => {
    expect(parseBuildCompleteEvent({})).toBeNull();
    expect(parseBuildCompleteEvent(null)).toBeNull();
    expect(parseBuildCompleteEvent("build.complete")).toBeNull();
    expect(parseBuildCompleteEvent({ eventType: "" })).toBeNull();
  });

  it("falls back to the merge ref when triggerInfo is absent", () => {
    const event = variant("event-build-complete-services", (resource) => {
      delete resource["triggerInfo"];
      resource["sourceBranch"] = "refs/pull/128/merge";
    });
    // No triggerInfo means no feature branch anywhere → no ticket key → null.
    expect(parseBuildCompleteEvent(event)).toBeNull();
  });

  it("takes the pull request id from the merge ref when pr.number is missing", () => {
    const event = variant("event-build-complete-services", (resource) => {
      resource["triggerInfo"] = { "pr.sourceBranch": "refs/heads/feature/UGURPAY-4312-iban" };
    });
    expect(parseBuildCompleteEvent(event)?.prId).toBe(128);
  });

  it("treats partiallySucceeded and canceled as failed (fail-closed 10b gate)", () => {
    for (const result of ["partiallySucceeded", "canceled", "none", "somethingNew"]) {
      const event = variant("event-build-complete-services", (resource) => {
        resource["result"] = result;
      });
      expect(parseBuildCompleteEvent(event)?.status).toBe("failed");
    }
  });

  it("reads the verdict from `status` on resourceVersion 1.0 payloads", () => {
    const succeeded = variant("event-build-complete-services", (resource) => {
      delete resource["result"];
      resource["status"] = "succeeded";
    });
    expect(parseBuildCompleteEvent(succeeded)?.status).toBe("succeeded");

    const failed = variant("event-build-complete-services", (resource) => {
      delete resource["result"];
      resource["status"] = "failed";
    });
    expect(parseBuildCompleteEvent(failed)?.status).toBe("failed");
  });

  it("recovers the branch from sourceGetVersion when no branch field exists", () => {
    const event = variant("event-build-complete-services", (resource) => {
      delete resource["sourceBranch"];
      resource["triggerInfo"] = { "pr.number": "128" };
      resource["sourceGetVersion"] =
        "LG:refs/heads/feature/UGURPAY-4312-iban-validation:b7a41f3c9d825e0641a2b3c4d5e6f708192a3b4c";
    });
    expect(parseBuildCompleteEvent(event)?.ticketKey).toBe("UGURPAY-4312");
  });

  it("falls back to lastChangedDate, then to the envelope date, for finishedAt", () => {
    const lastChanged = variant("event-build-complete-services", (resource) => {
      delete resource["finishTime"];
      resource["lastChangedDate"] = "2026-08-08T10:20:00.0000000Z";
    });
    expect(parseBuildCompleteEvent(lastChanged)?.finishedAt).toBe("2026-08-08T10:20:00.000Z");

    const envelopeDate = variant("event-build-complete-services", (resource) => {
      delete resource["finishTime"];
    });
    expect(parseBuildCompleteEvent(envelopeDate)?.finishedAt).toBe("2026-08-08T10:14:23.123Z");
  });

  it("reads a zone-less on-prem timestamp as UTC, not as local time", () => {
    const event = variant("event-build-complete-services", (resource) => {
      resource["finishTime"] = "2026-08-08T10:14:22.710";
    });
    expect(parseBuildCompleteEvent(event)?.finishedAt).toBe("2026-08-08T10:14:22.710Z");
  });

  it("drops a details URL that is not a URL instead of failing the signal", () => {
    const event = variant("event-build-complete-services", (resource) => {
      resource["_links"] = { web: { href: "not-a-url" } };
    });
    const signal = parseBuildCompleteEvent(event);
    expect(signal?.detailsUrl).toBeUndefined();
    expect(CiResultSignal.safeParse(signal).success).toBe(true);
  });

  it("throws instead of going silent when a build.complete resource is malformed", () => {
    const broken = { eventType: "build.complete", resource: { id: "not-a-number" } };
    expect(() => parseBuildCompleteEvent(broken)).toThrow(AdoResponseError);
  });

  it("throws when a Maestro build has no usable timestamp at all", () => {
    const event = structuredClone(fixture("event-build-complete-services")) as {
      resource: Record<string, unknown>;
      createdDate?: string;
    };
    delete event.resource["finishTime"];
    delete event.createdDate;
    expect(() => parseBuildCompleteEvent(event)).toThrow(/finish time/);
  });
});
