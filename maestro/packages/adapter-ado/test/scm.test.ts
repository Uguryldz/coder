import type { ApplicationRecord } from "@maestro/contracts";
import type { RepoRef } from "@maestro/ports";
import { describe, expect, it } from "vitest";
import {
  AdoClient,
  AdoNotFoundError,
  AdoResponseError,
  AdoScmDriver,
  parseAdoConfig,
  pushScope,
  type SecretIssuer,
} from "../src/index.js";
import { createFakeHttp, type FakeCall, type FakeReply, fixture, pathOf, queryOf } from "./helpers.js";

const CONFIG = parseAdoConfig({
  mode: "services",
  org: "ugurbank",
  tokenRef: "ado/services/pat",
});

const REPO: RepoRef = { project: "UgurPay", repo: "ugurpay" };

const APP: ApplicationRecord = {
  appId: "ugurpay",
  displayName: "UgurPay",
  adoProject: "UgurPay",
  adoRepo: "ugurpay",
  platform: "linux-node",
  jiraComponent: null,
  maestroYamlPresent: true,
  createdVia: "onboarding",
};

const issuer: SecretIssuer = (_scope, ttlSeconds) =>
  Promise.resolve({
    secret: "ephemeral-pat",
    expiresAt: new Date(Date.UTC(2026, 7, 8, 12, 0, 0) + ttlSeconds * 1000).toISOString(),
  });

function driver(handler: (call: FakeCall) => FakeReply, issueSecret: SecretIssuer = issuer) {
  const http = createFakeHttp(handler);
  const client = new AdoClient({ config: CONFIG, token: () => "pat", fetch: http.fetch });
  return { scm: new AdoScmDriver({ client, issueSecret }), calls: http.calls };
}

describe("AdoScmDriver.resolveRepo", () => {
  it("resolves an ApplicationRecord to the canonical project/repo names", async () => {
    const { scm, calls } = driver(() => ({ json: fixture("repo-get") }));
    await expect(scm.resolveRepo(APP)).resolves.toEqual({ project: "UgurPay", repo: "ugurpay" });
    expect(pathOf(calls[0]!)).toBe(
      "https://dev.azure.com/ugurbank/UgurPay/_apis/git/repositories/ugurpay",
    );
  });

  it("fails loudly when the registry points at a missing repository", async () => {
    const { scm } = driver(() => ({ status: 404, text: "TF401019" }));
    await expect(scm.resolveRepo(APP)).rejects.toBeInstanceOf(AdoNotFoundError);
  });

  it("rejects an Application Registry record that fails its own schema", async () => {
    const { scm } = driver(() => ({ json: fixture("repo-get") }));
    await expect(scm.resolveRepo({ ...APP, adoRepo: "" })).rejects.toThrow();
  });
});

describe("AdoScmDriver.createBranch", () => {
  it("pushes a ref update from the zero object id when given a commit id", async () => {
    const base = "9c1e5a3b7d2f4068a1b3c5d7e9f0a2b4c6d8e0f1";
    const { scm, calls } = driver(() => ({ json: fixture("refs-update-success") }));
    await scm.createBranch(REPO, "feature/UGURPAY-4312-iban-validation", base);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(pathOf(call)).toBe(
      "https://dev.azure.com/ugurbank/UgurPay/_apis/git/repositories/ugurpay/refs",
    );
    expect(call.body).toEqual([
      {
        name: "refs/heads/feature/UGURPAY-4312-iban-validation",
        oldObjectId: "0".repeat(40),
        newObjectId: base,
      },
    ]);
  });

  it("resolves a base branch name to its tip commit first", async () => {
    const { scm, calls } = driver((call) =>
      call.method === "GET"
        ? { json: fixture("refs-list") }
        : { json: fixture("refs-update-success") },
    );
    await scm.createBranch(REPO, "feature/UGURPAY-4312-iban-validation", "main");

    expect(calls).toHaveLength(2);
    expect(queryOf(calls[0]!, "filter")).toBe("heads/main");
    expect(calls[1]!.body).toMatchObject([
      { newObjectId: "9c1e5a3b7d2f4068a1b3c5d7e9f0a2b4c6d8e0f1" },
    ]);
  });

  it("throws when the base ref does not exist", async () => {
    const { scm } = driver(() => ({ json: { value: [], count: 0 } }));
    await expect(scm.createBranch(REPO, "feature/UGURPAY-1-x", "develop")).rejects.toBeInstanceOf(
      AdoResponseError,
    );
  });

  it("does not treat a rejected ref update (HTTP 200, success:false) as created", async () => {
    const { scm } = driver(() => ({ json: fixture("refs-update-rejected") }));
    await expect(
      scm.createBranch(REPO, "feature/UGURPAY-4312-iban-validation", "9".repeat(40)),
    ).rejects.toThrow(/stale/);
  });
});

describe("AdoScmDriver.getPushCredential", () => {
  it("passes the issued short-lived credential through under a stable scope", async () => {
    const scopes: string[] = [];
    const { scm, calls } = driver(
      () => ({ json: {} }),
      (scope, ttl) => {
        scopes.push(scope);
        return issuer(scope, ttl);
      },
    );
    const credential = await scm.getPushCredential(REPO, 900);

    expect(credential.token).toBe("ephemeral-pat");
    expect(credential.expiresAt).toBe("2026-08-08T12:15:00.000Z");
    expect(scopes).toEqual([pushScope(REPO)]);
    expect(pushScope(REPO)).toBe("ado/UgurPay/ugurpay/push");
    // No REST call: the credential comes from the SecretPort, not from ADO.
    expect(calls).toHaveLength(0);
  });

  it("rejects a non-positive ttl", async () => {
    const { scm } = driver(() => ({ json: {} }));
    await expect(scm.getPushCredential(REPO, 0)).rejects.toBeInstanceOf(AdoResponseError);
  });

  it("rejects an issuer that returns an empty secret or a bad expiry", async () => {
    const empty = driver(() => ({ json: {} }), () =>
      Promise.resolve({ secret: "", expiresAt: "2026-08-08T12:00:00.000Z" }),
    );
    await expect(empty.scm.getPushCredential(REPO, 60)).rejects.toThrow(/empty secret/);

    const badExpiry = driver(() => ({ json: {} }), () =>
      Promise.resolve({ secret: "s", expiresAt: "soon" }),
    );
    await expect(badExpiry.scm.getPushCredential(REPO, 60)).rejects.toThrow(/expiresAt/);
  });
});

describe("AdoScmDriver pull requests", () => {
  it("opens a draft PR with fully-qualified refs (M13)", async () => {
    const { scm, calls } = driver(() => ({ json: fixture("pr-create-draft") }));
    const result = await scm.openPr(REPO, {
      sourceBranch: "feature/UGURPAY-4312-iban-validation",
      targetBranch: "main",
      title: "[AI] UGURPAY-4312 IBAN validation",
      description: "Analysis summary and evidence link.",
      draft: true,
    });

    expect(result).toEqual({ prId: 128 });
    expect(calls[0]!.body).toEqual({
      sourceRefName: "refs/heads/feature/UGURPAY-4312-iban-validation",
      targetRefName: "refs/heads/main",
      title: "[AI] UGURPAY-4312 IBAN validation",
      description: "Analysis summary and evidence link.",
      isDraft: true,
    });
  });

  it("honours draft:false", async () => {
    const { scm, calls } = driver(() => ({ json: fixture("pr-get-active") }));
    await scm.openPr(REPO, {
      sourceBranch: "feature/UGURPAY-4312-iban-validation",
      targetBranch: "main",
      title: "t",
      description: "d",
      draft: false,
    });
    expect(calls[0]!.body).toMatchObject({ isDraft: false });
  });

  it("activates a draft PR and verifies the result", async () => {
    const { scm, calls } = driver(() => ({ json: fixture("pr-get-active") }));
    await scm.activatePr(REPO, 128);

    const call = calls[0]!;
    expect(call.method).toBe("PATCH");
    expect(pathOf(call)).toBe(
      "https://dev.azure.com/ugurbank/UgurPay/_apis/git/repositories/ugurpay/pullrequests/128",
    );
    expect(call.body).toEqual({ isDraft: false });
  });

  it("throws when ADO reports the PR as still a draft after activation", async () => {
    const { scm } = driver(() => ({ json: fixture("pr-create-draft") }));
    await expect(scm.activatePr(REPO, 128)).rejects.toBeInstanceOf(AdoResponseError);
  });

  it("maps PR state and merge commit for the gates", async () => {
    const active = driver(() => ({ json: fixture("pr-get-active") }));
    await expect(active.scm.getPrStatus(REPO, 128)).resolves.toEqual({
      prId: 128,
      state: "active",
      mergeSha: "d3f9a172c48b5e60a7d1c2b3e4f5061728394a5b",
    });

    const draft = driver(() => ({ json: fixture("pr-create-draft") }));
    const draftStatus = await draft.scm.getPrStatus(REPO, 128);
    expect(draftStatus.state).toBe("draft");
    expect(draftStatus.mergeSha).toBeNull();

    const completed = driver(() => ({ json: fixture("pr-get-completed") }));
    await expect(completed.scm.getPrStatus(REPO, 128)).resolves.toMatchObject({
      state: "completed",
      mergeSha: "d3f9a172c48b5e60a7d1c2b3e4f5061728394a5b",
    });

    const abandoned = driver(() => ({ json: fixture("pr-get-abandoned") }));
    await expect(abandoned.scm.getPrStatus(REPO, 129)).resolves.toEqual({
      prId: 129,
      state: "abandoned",
      mergeSha: null,
    });
  });

  it("refuses a malformed merge commit instead of reporting 'not merged'", async () => {
    const { scm } = driver(() => ({
      json: { ...(fixture("pr-get-completed") as object), lastMergeCommit: { commitId: "zzz" } },
    }));
    await expect(scm.getPrStatus(REPO, 128)).rejects.toThrow(/lastMergeCommit/);
  });

  it("refuses an unsupported PR status", async () => {
    const { scm } = driver(() => ({
      json: { ...(fixture("pr-get-active") as object), status: "notSet" },
    }));
    await expect(scm.getPrStatus(REPO, 128)).rejects.toThrow(/unsupported PR status/);
  });
});

describe("AdoScmDriver review threads (12b loop)", () => {
  it("maps ADO thread statuses onto the port's three states", async () => {
    const { scm, calls } = driver(() => ({ json: fixture("threads-list") }));
    const threads = await scm.listPrThreads(REPO, 128);

    expect(pathOf(calls[0]!)).toBe(
      "https://dev.azure.com/ugurbank/UgurPay/_apis/git/repositories/ugurpay/pullrequests/128/threads",
    );
    expect(threads.map((t) => [t.threadId, t.status])).toEqual([
      [9001, "active"],
      [9002, "fixed"],
      [9003, "closed"],
      [9006, "active"],
    ]);
  });

  it("keeps reviewer comments with author and timestamp", async () => {
    const { scm } = driver(() => ({ json: fixture("threads-list") }));
    const threads = await scm.listPrThreads(REPO, 128);

    expect(threads[0]!.comments).toEqual([
      {
        author: "Tech Lead",
        text: "IBAN checksum should reject lowercase input as well.",
        at: "2026-08-08T10:31:07.253Z",
      },
    ]);
    expect(threads[1]!.comments).toHaveLength(2);
  });

  it("drops deleted threads and system (vote/policy) threads", async () => {
    const { scm } = driver(() => ({ json: fixture("threads-list") }));
    const ids = (await scm.listPrThreads(REPO, 128)).map((t) => t.threadId);
    expect(ids).not.toContain(9004); // vote update, system comment only
    expect(ids).not.toContain(9005); // deleted thread
  });

  it("replies inside the thread, parented to its first comment", async () => {
    const { scm, calls } = driver(() => ({ json: fixture("thread-comment-created") }));
    await scm.replyThread(REPO, 128, 9001, "Addressed in the latest iteration.");

    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(pathOf(call)).toBe(
      "https://dev.azure.com/ugurbank/UgurPay/_apis/git/repositories/ugurpay" +
        "/pullrequests/128/threads/9001/comments",
    );
    expect(call.body).toEqual({
      content: "Addressed in the latest iteration.",
      parentCommentId: 1,
      commentType: "text",
    });
  });

  it("rejects a threads response that does not match the schema", async () => {
    const { scm } = driver(() => ({ json: { value: [{ id: "nine-thousand" }] } }));
    await expect(scm.listPrThreads(REPO, 128)).rejects.toBeInstanceOf(AdoResponseError);
  });
});

describe("AdoScmDriver in server mode", () => {
  it("uses collection-scoped URLs for the same calls", async () => {
    const http = createFakeHttp(() => ({ json: fixture("pr-create-draft") }));
    const client = new AdoClient({
      config: parseAdoConfig({
        mode: "server",
        baseUrl: "https://tfs.ugurbank.local/tfs",
        collection: "DefaultCollection",
        tokenRef: "ado/server/pat",
      }),
      token: () => "pat",
      fetch: http.fetch,
    });
    const scm = new AdoScmDriver({ client, issueSecret: issuer });
    await scm.openPr(REPO, {
      sourceBranch: "feature/UGURPAY-4312-iban-validation",
      targetBranch: "main",
      title: "t",
      description: "d",
      draft: true,
    });

    expect(pathOf(http.calls[0]!)).toBe(
      "https://tfs.ugurbank.local/tfs/DefaultCollection/UgurPay/_apis" +
        "/git/repositories/ugurpay/pullrequests",
    );
    expect(queryOf(http.calls[0]!, "api-version")).toBe("6.0");
  });
});
