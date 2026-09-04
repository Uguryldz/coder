import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { AiUsageScreen } from "../src/screens/AiUsage.tsx";
import { AuditScreen } from "../src/screens/Audit.tsx";
import { EvidenceScreen } from "../src/screens/Evidence.tsx";
import { YamlScreen } from "../src/screens/Yaml.tsx";
import { renderScreen, stubFetch } from "./harness.tsx";

/**
 * The Denetim group (P8): audit trail + decisions tab, AI usage, evidence,
 * protected paths. What these guard:
 *   - paging follows the BFF cursor and can come back;
 *   - the decision ledger is a tab of the trail and shows the chain flag;
 *   - money is rendered in the viewer's locale, and a call row links to its run;
 *   - the evidence screen validates and debounces the ticket key, and accepts
 *     one from the URL;
 *   - removing a protected path asks first.
 */

const user = userEvent.setup({ delay: null });

const VERIFICATION = { ok: true, checked: 12, brokenAtSeq: null };

function auditEvent(seq: number, action = "RUN_STARTED") {
  return {
    seq,
    at: "2026-08-09T03:00:00Z",
    actor: "maestro-worker",
    action,
    subject: `UGURPAY-${seq}`,
    prevHash: "genesis",
    hash: "b".repeat(64),
    meta: {},
  };
}

describe("audit trail — paging", () => {
  it("follows the server cursor forward and comes back to page one", async () => {
    const { fetchImpl, calls } = stubFetch([
      { path: "/studio/audit/verification", body: VERIFICATION },
      { path: "/studio/audit", body: { items: [auditEvent(1)], nextCursor: "c1" } },
    ]);
    renderScreen(<AuditScreen />, { fetchImpl });
    expect(await screen.findByText("UGURPAY-1")).toBeInTheDocument();

    // Page one: no way back yet, but a way forward.
    expect(screen.getByRole("button", { name: "Önceki sayfa" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Sonraki sayfa" }));
    await waitFor(() =>
      expect(calls.some((c) => c.url.includes("/studio/audit?") && c.url.includes("cursor=c1"))).toBe(true),
    );

    await user.click(screen.getByRole("button", { name: "Önceki sayfa" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Önceki sayfa" })).toBeDisabled());
  });

  it("renders no pager at all for a single page", async () => {
    const { fetchImpl } = stubFetch([
      { path: "/studio/audit/verification", body: VERIFICATION },
      { path: "/studio/audit", body: { items: [auditEvent(1)], nextCursor: null } },
    ]);
    renderScreen(<AuditScreen />, { fetchImpl });
    expect(await screen.findByText("UGURPAY-1")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sonraki sayfa" })).not.toBeInTheDocument();
    // The raw ISO timestamp is never shown; the locale form is.
    expect(screen.queryByText("2026-08-09T03:00:00Z")).not.toBeInTheDocument();
  });
});

describe("audit trail — decisions tab", () => {
  const DECISIONS = {
    decisions: [
      {
        decisionId: "audit-7",
        ref: "GATE_RETURN",
        question: "UGURPAY-7",
        action: "GATE_RETURN",
        actor: "ayse@corp",
        severity: "info",
        status: "returned",
        decidedAt: "2026-08-09T03:00:00Z",
        basis: { auditSeq: 7, chainVerified: true },
      },
    ],
    nextCursor: null,
    chainVerified: true,
  };

  it("opens from ?tab=decisions and shows the ledger with its chain flag", async () => {
    const { fetchImpl } = stubFetch([{ path: "/decisions", body: DECISIONS }]);
    renderScreen(<AuditScreen />, { fetchImpl, initialEntries: ["/audit?tab=decisions"] });

    expect(await screen.findByText("Karar defteri")).toBeInTheDocument();
    // The card's title is static; the chain flag arrives WITH the ledger.
    expect(await screen.findByText("zincir doğrulandı")).toBeInTheDocument();
    // Composed from two machine fields, translated — never `GATE_RETURN · ayse`.
    expect(screen.getByText("Kapıdan analize geri gönderildi · ayse@corp")).toBeInTheDocument();
    expect(screen.getByText("Analize geri gönderildi")).toBeInTheDocument();
    // The action IS the reference; a second column restating it is gone.
    expect(screen.queryByText("Referans")).not.toBeInTheDocument();
  });

  it("flags a ledger read off a chain that no longer reconciles", async () => {
    const { fetchImpl } = stubFetch([
      { path: "/decisions", body: { ...DECISIONS, chainVerified: false } },
    ]);
    renderScreen(<AuditScreen />, { fetchImpl, initialEntries: ["/audit?tab=decisions"] });
    expect(await screen.findByText("zincir doğrulanamadı")).toBeInTheDocument();
  });

  it("switches tabs without leaving the trail data behind", async () => {
    const { fetchImpl } = stubFetch([
      { path: "/studio/audit/verification", body: VERIFICATION },
      { path: "/studio/audit", body: { items: [auditEvent(1)], nextCursor: null } },
      { path: "/decisions", body: DECISIONS },
    ]);
    renderScreen(<AuditScreen />, { fetchImpl });
    expect(await screen.findByText("UGURPAY-1")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Kararlar" }));
    expect(await screen.findByText("Karar defteri")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Kayıtlar" }));
    expect(await screen.findByText("UGURPAY-1")).toBeInTheDocument();
  });
});

describe("AI usage & cost", () => {
  const CALL = {
    at: "2026-08-09T03:00:00Z",
    runId: "run-uuid-1",
    role: "engineer",
    variantId: "v1",
    driver: "openai-api",
    model: "gpt-x",
    tokensIn: 10,
    tokensOut: 5,
    usd: 12.3,
    dataClass: "dahili",
  };
  const RUN = {
    ticketKey: "UGURPAY-501",
    title: "t",
    appId: null,
    mode: "auto",
    risk: "low",
    dataClass: "dahili",
    parentTicketKey: null,
    childTicketKeys: [],
    reporter: "r",
    assignee: null,
    prId: null,
    costUsd: 12.3,
    tokensIn: 10,
    tokensOut: 5,
    startedAt: "2026-08-09T03:00:00Z",
    updatedAt: "2026-08-09T03:00:00Z",
    archivedAt: null,
    state: { runId: "run-uuid-1", status: "running", step: "1", risk: "low", startedAt: "2026-08-09T03:00:00Z" },
  };
  const QUOTA = {
    pool: { hasCapacity: true, ready: 1, cooling: 0, exhausted: 0, disabled: 0 },
    accounts: [
      {
        accountId: "acc-1",
        driver: "claude-sub",
        state: "ready",
        windows: [{ kind: "5h", usedPct: 40, resetsAt: "2026-08-09T08:00:00Z" }],
      },
    ],
  };

  it("shows dollars in the viewer's locale and links a call to its run", async () => {
    const { fetchImpl } = stubFetch([
      { path: "/studio/cost", body: { items: [CALL], nextCursor: null } },
      { path: "/studio/runs", body: { items: [RUN], nextCursor: null } },
      { path: "/studio/quota", body: QUOTA },
    ]);
    renderScreen(<AiUsageScreen />, { fetchImpl });

    const link = await screen.findByRole("link", { name: "UGURPAY-501" });
    expect(link).toHaveAttribute("href", "/detail/UGURPAY-501");
    // "$12.30" is the en form; tr renders the same amount with a decimal
    // COMMA ("$12,30" under ICU — sign placement is the formatter's call, the
    // comma is what proves the locale was honoured).
    expect(screen.getAllByText(/(\$\s?12,30|12,30\s?\$)/).length).toBeGreaterThan(0);
    expect(screen.queryByText("$12.30")).not.toBeInTheDocument();
    expect(screen.queryByText("2026-08-09T03:00:00Z")).not.toBeInTheDocument();
  });

  it("shows the pool on the traffic tab and the call log only once", async () => {
    const { fetchImpl } = stubFetch([
      { path: "/studio/cost", body: { items: [CALL], nextCursor: null } },
      { path: "/studio/runs", body: { items: [], nextCursor: null } },
      { path: "/studio/quota", body: QUOTA },
    ]);
    renderScreen(<AiUsageScreen />, { fetchImpl, initialEntries: ["/cost?view=traffic"] });

    expect(await screen.findByText("acc-1")).toBeInTheDocument();
    expect(screen.queryByText("Gateway çağrı kaydı")).not.toBeInTheDocument();
    expect(screen.queryByText("2026-08-09T08:00:00Z")).not.toBeInTheDocument();
  });
});

describe("evidence — ticket key", () => {
  const PACKAGE = {
    ticketKey: "UGURPAY-123",
    runId: "run-1",
    createdAt: "2026-08-02T09:00:00.000Z",
    templateVersion: "v3",
    files: [{ name: "01-analiz.md", sha256: "a".repeat(64), bytes: 28672, contentType: "text/markdown" }],
    approvals: [],
    retentionYears: 10,
    objectLock: true,
  };

  it("loads the package named by ?ticket= without typing", async () => {
    const { fetchImpl, calls } = stubFetch([
      { path: "/studio/runs/UGURPAY-123/evidence", body: PACKAGE },
    ]);
    renderScreen(<EvidenceScreen />, { fetchImpl, initialEntries: ["/evidence?ticket=UGURPAY-123"] });
    expect(await screen.findByText("01-analiz.md")).toBeInTheDocument();
    expect(calls).toHaveLength(1);
  });

  it("refuses a malformed key locally, without asking the server", async () => {
    const { fetchImpl, calls } = stubFetch([]);
    renderScreen(<EvidenceScreen />, { fetchImpl });
    await user.type(screen.getByLabelText("Ticket"), "ugurpay");
    expect(await screen.findByText("Ticket anahtarı PROJE-123 biçiminde olmalı.")).toBeInTheDocument();
    expect(calls).toHaveLength(0);
    // The input upper-cases as the operator types: the key is case-fixed.
    expect(screen.getByLabelText("Ticket")).toHaveValue("UGURPAY");
  });
});

describe("protected paths — removal asks first", () => {
  const POLICY = {
    appId: "ugurpay",
    platform: "linux-node",
    repo: "Odeme/_git/ugurpay",
    yaml: "platform: linux-node",
    protectedPaths: { platformDefaults: ["prisma/migrations/**"], repoAdditions: ["src/payment-core/**"] },
    fetchedAt: "2026-08-08T12:00:00.000Z",
  };

  it("does not delete on the first click; deletes after confirmation", async () => {
    const { fetchImpl, calls } = stubFetch([
      { path: "/repo-policy", body: { policies: [POLICY] } },
      { path: "/protected-paths/src%2Fpayment-core%2F**", method: "DELETE", body: POLICY },
    ]);
    renderScreen(<YamlScreen />, { fetchImpl });

    await user.click(await screen.findByRole("button", { name: "Kaldır" }));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);

    const dialog = screen.getByRole("dialog", { hidden: true });
    expect(within(dialog).getByText(/src\/payment-core\/\*\* korumalı yollardan çıkarılacak/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Kaldır", hidden: true }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
  });

  it("cancelling leaves the path protected", async () => {
    const { fetchImpl, calls } = stubFetch([{ path: "/repo-policy", body: { policies: [POLICY] } }]);
    renderScreen(<YamlScreen />, { fetchImpl });

    await user.click(await screen.findByRole("button", { name: "Kaldır" }));
    const dialog = screen.getByRole("dialog", { hidden: true });
    await user.click(within(dialog).getByRole("button", { name: "Vazgeç", hidden: true }));
    await waitFor(() => expect(screen.queryByRole("dialog", { hidden: true })).not.toBeInTheDocument());
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });
});
