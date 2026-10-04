import type { CiResultSignal, ScanResult } from "@maestro/contracts";
import { describe, expect, it } from "vitest";
import {
  activatePullRequest,
  buildEvidencePackage,
  closeTicket,
  deliverAnalysis,
  mergePullRequest,
  openPullRequest,
  pollBuild,
  publishBranch,
  verifyCiOrigin,
} from "../src/impl/delivery.js";
import { runScans, scannerErrorResult } from "../src/impl/scan.js";
import { APP, makeFakes } from "./fakes.js";

const PASS: ScanResult = {
  tool: "gitleaks",
  imageDigest: "sha256:aa",
  startedAt: "2026-08-09T09:00:00+03:00",
  finishedAt: "2026-08-09T09:00:01+03:00",
  findings: [],
  outcome: "pass",
};

const ci = (over: Partial<CiResultSignal> = {}): CiResultSignal => ({
  ticketKey: "PAY-101",
  adoProject: APP.adoProject,
  adoRepo: APP.adoRepo,
  prId: 77,
  buildId: 900,
  status: "succeeded",
  finishedAt: "2026-08-09T10:00:00+03:00",
  ...over,
});

describe("runScans (step 6b, M27 fail-closed)", () => {
  it("runs the mandatory trio and nothing else", async () => {
    const fakes = makeFakes({ scan: (tool) => ({ ...PASS, tool: tool as ScanResult["tool"] }) });
    const results = await runScans(fakes.deps, "PAY-101");

    expect(fakes.recorded.scans).toEqual(["gitleaks", "semgrep", "trivy"]);
    expect(results.every((r) => r.outcome === "pass")).toBe(true);
    expect(fakes.journalStore.entries.at(-1)?.title).toBe("tarama temiz");
  });

  it("a scanner that cannot run is a BLOCKING result, not a missing one", async () => {
    const fakes = makeFakes({
      scan: (tool) => {
        if (tool === "trivy") throw new Error("image pull failed");
        return { ...PASS, tool: tool as ScanResult["tool"] };
      },
    });
    const results = await runScans(fakes.deps, "PAY-101");

    // Three results, one of them an error — the flow can see it and stop.
    expect(results).toHaveLength(3);
    const trivy = results.find((r) => r.tool === "trivy");
    expect(trivy?.outcome).toBe("error");
    expect(trivy?.findings[0]?.message).toContain("image pull failed");
    expect(fakes.journalStore.entries.at(-1)?.title).toBe("tarama bloke etti");
  });

  it("records the failure on the audit trail with the right action", async () => {
    const fakes = makeFakes({ scan: (tool) => ({ ...PASS, tool: tool as ScanResult["tool"], outcome: "fail" }) });
    await runScans(fakes.deps, "PAY-101");
    const events = await fakes.chain.verify();
    expect(events.ok).toBe(true);
  });

  /**
   * ÇALIŞMA ALANI YOKKEN TARAMA YEŞİL VEREMEZ.
   *
   * Ölçülmüş arıza: koşu satırındaki `workspacePath` koşu açılırken yazılır ve
   * bir daha diske bakılmaz; `workspacePresent` kod tabanında hiçbir yerde
   * `false` yazılmaz. Servis yeniden başlayıp çalışma alanı silindiğinde satır
   * aynı kalırdı, tarayıcılar BOŞ bir dizini tarardı, hiçbir bulgu çıkmazdı ve
   * akış `SECURITY_SCAN_PASS` yazardı — yani tarama hiç bakmadan "temiz" derdi.
   *
   * Bulgusuzluk ile bakmamışlık aynı şey değildir. Bu testin koruduğu tek
   * cümle budur.
   */
  it("çalışma alanı yokken tarama TEMİZ demez, BLOKLAR", async () => {
    const fakes = makeFakes({
      context: { workspacePath: "" },
      // Tarayıcı çağrılırsa geçerdi; asıl iddia çağrılMAMASI.
      scan: (tool) => ({ ...PASS, tool: tool as ScanResult["tool"] }),
    });
    const results = await runScans(fakes.deps, "PAY-101");

    expect(fakes.recorded.scans, "boş dizinde tarayıcı hiç çağrılmamalı").toEqual([]);
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.outcome === "error")).toBe(true);
    for (const result of results) {
      expect(result.findings[0]?.severity).toBe("critical");
      expect(result.findings[0]?.message).toContain("çalışma alanı yok");
    }
    expect(fakes.journalStore.entries.at(-1)?.title).toBe("tarama bloke etti");
  });

  it("çalışma alanı yokken denetim kaydı PASS yazmaz", async () => {
    const fakes = makeFakes({
      context: { workspacePath: "" },
      scan: (tool) => ({ ...PASS, tool: tool as ScanResult["tool"] }),
    });
    const results = await runScans(fakes.deps, "PAY-101");
    const events = await fakes.chain.verify();
    expect(events.ok).toBe(true);
    // Denetim kaydına giren eylem sonuçlardan türetiliyor (`isScanBlocking`);
    // hiçbiri `pass` değilse yazılan eylem PASS olamaz.
    expect(results.some((r) => r.outcome === "pass")).toBe(false);
    expect(fakes.journalStore.entries.at(-1)?.title).toBe("tarama bloke etti");
  });

  it("the synthesised error result is a valid, maximally severe finding", () => {
    const result = scannerErrorResult("semgrep", "2026-08-09T09:00:00+03:00", "boom");
    expect(result.outcome).toBe("error");
    expect(result.findings[0]?.severity).toBe("critical");
  });

  /**
   * Y3: the M54 loop scans up to three times, and the evidence package must
   * show three scans. A key derived from the RESULT collapses identical rounds
   * into one record — the auditor is then shown one scan where three happened.
   */
  it("every scan round leaves its own record (Y3)", async () => {
    const fakes = makeFakes({
      scan: (tool) => ({ ...PASS, tool: tool as ScanResult["tool"], outcome: "fail" }),
    });

    // Three rounds with identical findings, exactly as a repeated 6a→6b lap
    // produces them.
    await runScans(fakes.deps, "PAY-101", 1);
    await runScans(fakes.deps, "PAY-101", 2);
    await runScans(fakes.deps, "PAY-101", 3);

    const scanEntries = fakes.journalStore.entries.filter((e) => e.kind === "scan");
    expect(scanEntries).toHaveLength(3);
    const events = await fakes.chain.verify();
    expect(events.ok).toBe(true);
  });

  /** A genuine retry of the SAME round must still collapse to one record. */
  it("a retry of the same round is still written once (Y3)", async () => {
    const fakes = makeFakes({
      scan: (tool) => ({ ...PASS, tool: tool as ScanResult["tool"], outcome: "fail" }),
    });
    await runScans(fakes.deps, "PAY-101", 1);
    await runScans(fakes.deps, "PAY-101", 1);

    expect(fakes.journalStore.entries.filter((e) => e.kind === "scan")).toHaveLength(1);
  });
});

describe("the pull request", () => {
  it("opens once and remembers the id", async () => {
    const fakes = makeFakes();
    const pr = await openPullRequest(fakes.deps, "PAY-101");
    const again = await openPullRequest(fakes.deps, "PAY-101");

    expect(pr).toEqual({ adoProject: "BANK", adoRepo: "pay", prId: 77 });
    expect(again).toEqual(pr);
    expect(fakes.patches).toContainEqual({ prId: 77 });
    await activatePullRequest(fakes.deps, "PAY-101", pr);
  });

  it("refuses to record a merge sha before the PR is completed (M106)", async () => {
    const fakes = makeFakes({ context: { mode: "human_lead" }, prState: { state: "active", mergeSha: "preview1" } });
    const out = await mergePullRequest(fakes.deps, "PAY-101", { adoProject: "BANK", adoRepo: "pay", prId: 77 });
    expect(out.mergeSha).toBeNull();
    expect(out.state).toBe("active");
  });

  it("records the merge once the PR is completed", async () => {
    const fakes = makeFakes();
    const merged = await mergePullRequest(fakes.deps, "PAY-101", {
      adoProject: "BANK",
      adoRepo: "pay",
      prId: 77,
    });
    expect(merged.mergeSha).toBe("abcdef1");
  });
});

describe("verifyCiOrigin (M106)", () => {
  it("accepts a build from this run's repository", async () => {
    const fakes = makeFakes({ context: { prId: 77 } });
    expect(await verifyCiOrigin(fakes.deps, "PAY-101", ci())).toBe(true);
  });

  it("rejects a mirrored repository carrying the same branch and PR id", async () => {
    const fakes = makeFakes({ context: { prId: 77 } });
    expect(await verifyCiOrigin(fakes.deps, "PAY-101", ci({ adoRepo: "pay-mirror" }))).toBe(false);
    expect(await verifyCiOrigin(fakes.deps, "PAY-101", ci({ adoProject: "OTHER", buildId: 901 }))).toBe(false);
  });

  it("rejects an origin the driver could not determine — absence is not a match", async () => {
    const fakes = makeFakes({ context: { prId: 77 } });
    const anonymous = { ...ci(), adoProject: undefined, adoRepo: undefined };
    expect(await verifyCiOrigin(fakes.deps, "PAY-101", anonymous)).toBe(false);
  });

  it("rejects a build for another ticket or another pull request", async () => {
    const fakes = makeFakes({ context: { prId: 77 } });
    expect(await verifyCiOrigin(fakes.deps, "PAY-101", ci({ ticketKey: "PAY-999" }))).toBe(false);
    expect(await verifyCiOrigin(fakes.deps, "PAY-101", ci({ prId: 78, buildId: 902 }))).toBe(false);
  });

  it("puts every decision — accepted or not — on the audit trail", async () => {
    const fakes = makeFakes({ context: { prId: 77 } });
    await verifyCiOrigin(fakes.deps, "PAY-101", ci({ adoRepo: "pay-mirror" }));
    const events = await fakes.chain.verify();
    expect(events.ok).toBe(true);
    expect(events.checked).toBe(1);
  });
});

describe("buildEvidencePackage (step 13, M34)", () => {
  it("verifies the audit chain, stores the files and publishes the summary", async () => {
    const fakes = makeFakes();
    await fakes.chain.append({ actor: "maestro-worker", action: "RUN_STARTED", subject: "PAY-101" });
    const built = await buildEvidencePackage(fakes.deps, "PAY-101");

    expect(built.files).toBe(4);
    expect(built.storageKey).toBe("evidence/2026/PAY-101/run-pay-101-0001/manifest.json");
    expect(fakes.recorded.stored.map((s) => s.key)).toEqual([
      "evidence/2026/PAY-101/run-pay-101-0001/journal.json",
      "evidence/2026/PAY-101/run-pay-101-0001/approvals.json",
      "evidence/2026/PAY-101/run-pay-101-0001/audit-verification.json",
      "evidence/2026/PAY-101/run-pay-101-0001/manifest.json",
    ]);
    expect(fakes.recorded.published[0]?.doc).toBe("evidence_summary");
  });

  it("refuses to build a package on top of an empty (unverifiable) trail", async () => {
    const fakes = makeFakes();
    await expect(buildEvidencePackage(fakes.deps, "PAY-101")).rejects.toMatchObject({
      type: "AuditChainBroken",
    });
    expect(fakes.recorded.stored).toEqual([]);
  });
});

describe("closeTicket", () => {
  it("comments, labels and closes the run exactly once", async () => {
    const fakes = makeFakes();
    await closeTicket(fakes.deps, "PAY-101");
    await closeTicket(fakes.deps, "PAY-101");

    expect(fakes.recorded.comments).toHaveLength(1);
    expect(fakes.recorded.labels).toEqual([["maestro-tamamlandi"]]);
    expect((await fakes.chain.verify()).checked).toBe(1);
  });

  /**
   * Found live on OPS-40: Temporal reported the execution `Completed` while its
   * row still said `running`. `RunContextStore.get` reads the newest run whose
   * status is NOT terminal, so a finished run that never writes this stays live
   * forever — Studio lists it as running, and intake keeps joining it instead of
   * starting the ticket's next run.
   */
  it("marks the row done, so the run is over on both sides", async () => {
    const fakes = makeFakes();
    await closeTicket(fakes.deps, "PAY-101");
    expect(fakes.patches).toContainEqual({ status: "done" });
  });
});

describe("deliverAnalysis", () => {
  it("tells the ticket and hands it to the requester", async () => {
    const fakes = makeFakes();
    await deliverAnalysis(fakes.deps, "PAY-101", null);

    expect(fakes.recorded.comments).toHaveLength(1);
    expect(fakes.recorded.assignments).toEqual([{ ticket: "PAY-101", to: "reporter@bank" }]);
  });

  /**
   * Fail-soft on purpose. The analysis is already written, published and
   * approved by a human; failing here would burn three retries and then kill a
   * run whose deliverable is complete.
   */
  it("records a failed assignment instead of failing the run", async () => {
    const fakes = makeFakes({ assignFails: true });
    await deliverAnalysis(fakes.deps, "PAY-101", null);

    const last = fakes.journalStore.entries.at(-1);
    expect(last?.title).toBe("analiz teslim edildi");
    expect(last?.detail).toContain("atama yapılamadı");
  });
});

describe("publishBranch (6a → dal → PR)", () => {
  const PR = { adoProject: "BANK", adoRepo: "pay", prId: 77 };

  it("refuses without opening anything when the deployment cannot publish", async () => {
    const fakes = makeFakes({ context: { workspacePath: "/w/PAY-101", workspacePresent: true, branch: "" } });
    const out = await publishBranch(fakes.deps, "PAY-101");
    expect(out.pushed).toBe(false);
    expect(out.branch).toBe("maestro/pay-101");
    expect(fakes.journalStore.entries.at(-1)?.title).toBe("dal yayımlanamadı");
  });

  it("a turn that changed nothing yields no PR and says so", async () => {
    const fakes = makeFakes({
      context: { workspacePath: "/w/PAY-101", workspacePresent: true, branch: "" },
      publishWorkspace: () => Promise.resolve({ pushed: false, reason: "no_changes" }),
    });
    const out = await publishBranch(fakes.deps, "PAY-101");
    expect(out).toMatchObject({ pushed: false, reason: expect.stringContaining("hiçbir dosyayı değiştirmedi") });
    expect(fakes.patches.some((p) => p.branch !== undefined)).toBe(false);
  });

  it("commits, pushes, remembers the branch on the run and audits the push", async () => {
    const requests: unknown[] = [];
    const fakes = makeFakes({
      context: { workspacePath: "/w/PAY-101", workspacePresent: true, branch: "" },
      publishWorkspace: (request) => {
        requests.push(request);
        return Promise.resolve({ pushed: true, sha: "feedface00112233", files: 3, credential: "connection" });
      },
    });
    const out = await publishBranch(fakes.deps, "PAY-101");
    expect(out).toEqual({ pushed: true, branch: "maestro/pay-101", sha: "feedface00112233", files: 3 });
    expect(requests[0]).toMatchObject({ appId: APP.appId, workspacePath: "/w/PAY-101", branch: "maestro/pay-101" });
    expect(fakes.patches).toContainEqual({ branch: "maestro/pay-101" });
    const last = fakes.journalStore.entries.at(-1);
    expect(last?.title).toBe("dal yayımlandı");
    expect(last?.detail).toContain("bağlantı jetonu");
    const events = await fakes.chain.verify();
    expect(events.ok).toBe(true);
  });

  it("keeps a branch the run already has", async () => {
    const fakes = makeFakes({
      context: { workspacePath: "/w/PAY-101", workspacePresent: true, branch: "maestro/pay-101" },
      publishWorkspace: () => Promise.resolve({ pushed: true, sha: "abc", files: 1, credential: "short_lived" }),
    });
    const out = await publishBranch(fakes.deps, "PAY-101");
    expect(out.branch).toBe("maestro/pay-101");
  });

  it("pollBuild is unsupported without commit checks and relays them when present", async () => {
    const none = makeFakes();
    expect(await pollBuild(none.deps, "PAY-101", "abc")).toEqual({ state: "unsupported", detail: [] });
    const withChecks = makeFakes({
      getCommitChecks: (_repo, sha) => Promise.resolve({ sha, state: "failure", detail: ["build ✗"] }),
    });
    expect(await pollBuild(withChecks.deps, "PAY-101", "abc")).toEqual({ state: "failure", detail: ["build ✗"] });
  });

  it("mergePullRequest: an open PR outside full_auto is a wait, not a failure", async () => {
    const fakes = makeFakes({ context: { mode: "ai_assist" }, prState: { state: "active", mergeSha: null } });
    const out = await mergePullRequest(fakes.deps, "PAY-101", PR);
    expect(out).toEqual({ mergeSha: null, state: "active", by: null });
  });

  it("mergePullRequest: full_auto merges through the SCM and records who did it", async () => {
    const merged: number[] = [];
    const fakes = makeFakes({
      context: { mode: "full_auto" },
      prState: { state: "active", mergeSha: null },
      mergePr: (_repo, prId) => {
        merged.push(prId);
        return Promise.resolve({ mergeSha: "m3rge5ha" });
      },
    });
    const out = await mergePullRequest(fakes.deps, "PAY-101", PR);
    expect(out).toEqual({ mergeSha: "m3rge5ha", state: "completed", by: "maestro" });
    expect(merged).toEqual([77]);
    expect(fakes.journalStore.entries.at(-1)?.title).toContain("full_auto");
  });

  it("mergePullRequest: an abandoned PR is reported, never merged", async () => {
    const fakes = makeFakes({ context: { mode: "full_auto" }, prState: { state: "abandoned", mergeSha: null }, mergePr: () => Promise.reject(new Error("must not be called")) });
    const out = await mergePullRequest(fakes.deps, "PAY-101", PR);
    expect(out.state).toBe("abandoned");
    expect(out.mergeSha).toBeNull();
  });
});
