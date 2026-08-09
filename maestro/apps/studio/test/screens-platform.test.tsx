import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { CommandsScreen } from "../src/screens/Commands.tsx";
import { HealthScreen } from "../src/screens/Health.tsx";
import { McpScreen } from "../src/screens/Mcp.tsx";
import { NotifyScreen } from "../src/screens/Notify.tsx";
import { OnboardScreen } from "../src/screens/Onboard.tsx";
import { RunnersScreen } from "../src/screens/Runners.tsx";
import { SandboxScreen } from "../src/screens/Sandbox.tsx";
import { YamlScreen } from "../src/screens/Yaml.tsx";
import { renderScreen, stubFetch } from "./harness.tsx";

function runner(overrides: Record<string, unknown>) {
  return {
    id: "lnx-01",
    host: "lnx-01.ugurbank.local",
    pool: "docker-linux",
    platform: "linux-node",
    capacity: 4,
    busy: 2,
    jobs: [],
    status: "ok",
    messageKey: null,
    lastSeenAt: "2026-08-08T12:00:00.000Z",
    ...overrides,
  };
}

describe("runners screen", () => {
  it("puts an unreachable machine at the top and raises an alert", async () => {
    const { fetchImpl } = stubFetch([
      {
        path: "/runners",
        body: {
          runners: [
            runner({ id: "aaa-healthy", status: "ok" }),
            runner({ id: "zzz-dead", status: "unreachable", busy: 0 }),
          ],
        },
      },
    ]);
    renderScreen(<RunnersScreen />, { fetchImpl });

    expect(await screen.findByText(/1 makineye ulaşılamıyor/)).toBeInTheDocument();

    // Worst news first: the dead machine must precede the healthy one, even
    // though it sorts last alphabetically.
    const rows = screen.getAllByRole("row").slice(1);
    expect(within(rows[0] as HTMLElement).getByText("zzz-dead")).toBeInTheDocument();
  });

  it("excludes an unreachable machine's slots from the pool capacity", async () => {
    const { fetchImpl } = stubFetch([
      {
        path: "/runners",
        body: {
          runners: [
            runner({ id: "a", capacity: 4, busy: 2, status: "ok" }),
            runner({ id: "b", capacity: 4, busy: 4, status: "unreachable" }),
          ],
        },
      },
    ]);
    renderScreen(<RunnersScreen />, { fetchImpl });

    // The pool tile counts the reachable node only — 2/4, never 6/8.
    await screen.findByText(/1 ulaşılamıyor/);
    const tile = screen.getByText(/1 ulaşılamıyor/).closest("section") as HTMLElement;
    expect(within(tile).getByText("2/4")).toBeInTheDocument();
    expect(screen.queryByText("6/8")).not.toBeInTheDocument();
  });

  it("shows a translated failure instead of the server code", async () => {
    const { fetchImpl } = stubFetch([
      { path: "/runners", status: 500, body: { error: "internal_error" } },
    ]);
    renderScreen(<RunnersScreen />, { fetchImpl });

    expect(await screen.findByText("Sunucuda bir hata oluştu.")).toBeInTheDocument();
    expect(screen.queryByText(/internal_error/)).not.toBeInTheDocument();
  });
});

describe("sandbox screen", () => {
  it("shows an empty state rather than inventing a session", async () => {
    const { fetchImpl } = stubFetch([{ path: "/sandbox", body: { sessions: [] } }]);
    renderScreen(<SandboxScreen />, { fetchImpl });

    expect(await screen.findByText("Açık sandbox oturumu yok")).toBeInTheDocument();
  });

  it("renders the session envelope and its limits", async () => {
    const { fetchImpl } = stubFetch([
      {
        path: "/sandbox",
        body: {
          sessions: [
            {
              sessionId: "s1",
              ticketKey: "UGURPAY-501",
              runnerId: "lnx-01",
              pool: "docker-linux",
              image: "node:24-bookworm",
              workspaceMounted: true,
              resumed: true,
              turn: 4,
              memoryMb: 4096,
              cpus: 2,
              pids: 512,
              timeoutMinutes: 20,
              egressTargets: 3,
              startedAt: "2026-08-08T12:00:00.000Z",
              tools: [{ name: "jira-mcp", scope: "read" }],
            },
          ],
        },
      },
    ]);
    renderScreen(<SandboxScreen />, { fetchImpl });

    // Listed in the table AND named as the subject of the detail card.
    expect(await screen.findAllByText("UGURPAY-501")).toHaveLength(2);
    expect(screen.getByText("4096 MB · 2 vCPU · 512 pid")).toBeInTheDocument();
    expect(screen.getByText("jira-mcp")).toBeInTheDocument();
  });
});

describe("yaml screen", () => {
  const POLICY = {
    appId: "ugurpay",
    platform: "linux-node",
    repo: "Odeme/_git/ugurpay",
    yaml: "platform: linux-node\ncommands:\n  build: npm run build",
    protectedPaths: {
      platformDefaults: ["prisma/migrations/**", ".env*"],
      repoAdditions: ["src/payment-core/**"],
    },
    fetchedAt: "2026-08-08T12:00:00.000Z",
  };

  it("lists platform defaults read-only and offers removal only for repo additions", async () => {
    const { fetchImpl } = stubFetch([{ path: "/repo-policy", body: { policies: [POLICY] } }]);
    renderScreen(<YamlScreen />, { fetchImpl });

    expect(await screen.findByText("prisma/migrations/**")).toBeInTheDocument();
    expect(screen.getByText("kaldırılamaz")).toBeInTheDocument();

    // Exactly one remove control: the repo addition. A default must offer none.
    const removeButtons = screen.getAllByRole("button", { name: "Kaldır" });
    expect(removeButtons).toHaveLength(1);
    expect(screen.getByText("src/payment-core/**")).toBeInTheDocument();
  });

  it("only ever adds a protected path, never deletes a default", async () => {
    const { fetchImpl, calls } = stubFetch([
      { path: "/repo-policy", body: { policies: [POLICY] } },
      { path: "/protected-paths", method: "POST", body: POLICY },
    ]);
    renderScreen(<YamlScreen />, { fetchImpl });

    await userEvent.type(await screen.findByLabelText("Yeni korumalı yol"), "keystore/**");
    await userEvent.click(screen.getByRole("button", { name: "Ekle" }));

    await waitFor(() => {
      const post = calls.find((call) => call.method === "POST");
      expect(post?.body).toEqual({ path: "keystore/**" });
    });
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  it("refuses to send an empty path", async () => {
    const { fetchImpl, calls } = stubFetch([
      { path: "/repo-policy", body: { policies: [POLICY] } },
    ]);
    renderScreen(<YamlScreen />, { fetchImpl });

    await userEvent.click(await screen.findByRole("button", { name: "Ekle" }));
    expect(await screen.findByText("Yol boş olamaz.")).toBeInTheDocument();
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });
});

describe("mcp screen", () => {
  it("shows the forbidden tools as absent by design", async () => {
    const { fetchImpl } = stubFetch([
      {
        path: "/mcp/manifest",
        body: {
          endpoint: "/mcp",
          auditActor: "ai-via:ugur.yildiz@ugurbank.local",
          tools: [
            {
              name: "propose_killswitch",
              scope: "admin-proposal",
              descriptionKey: "params.description.kill_switch_state",
            },
          ],
          forbiddenTools: ["approve_gate", "reject_gate", "merge_pr"],
        },
      },
    ]);
    renderScreen(<McpScreen />, { fetchImpl });

    expect(await screen.findByText("approve_gate")).toBeInTheDocument();
    expect(screen.getByText("merge_pr")).toBeInTheDocument();
    expect(screen.getByText(/karar veremez/)).toBeInTheDocument();
    // The proposal scope must be labelled as such, not as a plain admin power.
    expect(screen.getByText("admin-öneri")).toBeInTheDocument();
  });
});

describe("health screen", () => {
  const BASE = {
    services: [
      { id: "postgres", status: "ok", version: "16.4", uptimeSeconds: 5_270_400, noteKey: null },
    ],
    workflows: { open: 9, longestDays: 16, continueAsNew: 2, failedActivities: 3 },
    audit: { queued: 0, lastShippedAt: "14:12", lastAnchorAt: "03:00" },
  };

  it("flags a restore drill that has never been run", async () => {
    const { fetchImpl } = stubFetch([
      {
        path: "/health",
        body: {
          ...BASE,
          backup: { databaseAt: "03:00", vaultAt: "03:10", restoreDrillAt: null },
        },
      },
    ]);
    renderScreen(<HealthScreen />, { fetchImpl });

    expect(await screen.findByText("yapılmadı")).toBeInTheDocument();
    expect(screen.getByText(/geri dönebilmek demek değildir/i)).toBeInTheDocument();
  });

  it("drops the warning once a drill has happened", async () => {
    const { fetchImpl } = stubFetch([
      {
        path: "/health",
        body: {
          ...BASE,
          backup: { databaseAt: "03:00", vaultAt: "03:10", restoreDrillAt: "2026-07-01" },
        },
      },
    ]);
    renderScreen(<HealthScreen />, { fetchImpl });

    expect(await screen.findByText("2026-07-01")).toBeInTheDocument();
    expect(screen.queryByText(/geri dönebilmek demek değildir/i)).not.toBeInTheDocument();
  });

  it("shows an unknown service by its id instead of blanking the page", async () => {
    const { fetchImpl } = stubFetch([
      {
        path: "/health",
        body: {
          ...BASE,
          services: [
            ...BASE.services,
            { id: "brand_new_thing", status: "down", version: null, uptimeSeconds: null, noteKey: null },
          ],
          backup: { databaseAt: null, vaultAt: null, restoreDrillAt: "2026-07-01" },
        },
      },
    ]);
    renderScreen(<HealthScreen />, { fetchImpl });

    // The catalogued one still renders...
    expect(await screen.findByText("PostgreSQL")).toBeInTheDocument();
    // ...and the uncatalogued one appears rather than throwing.
    expect(screen.getByText("brand_new_thing")).toBeInTheDocument();
  });
});

describe("commands screen", () => {
  it("states that a comment with extra text is not an approval", async () => {
    const { fetchImpl } = stubFetch([
      {
        path: "/commands",
        body: {
          commands: [
            {
              name: "/approve",
              roles: ["tech-lead"],
              takesArgument: false,
              whenKey: "commands.check.right_step",
              effectKey: "commands.check.sod",
            },
          ],
        },
      },
    ]);
    renderScreen(<CommandsScreen />, { fetchImpl });

    expect(await screen.findByText("/approve")).toBeInTheDocument();
    expect(screen.getByText(/onay SAYILMAZ/)).toBeInTheDocument();
    expect(screen.getByText(/sonradan onay yazılamaz/)).toBeInTheDocument();
  });
});

describe("notify screen", () => {
  it("says no rung of the ladder auto-rejects", async () => {
    const { fetchImpl } = stubFetch([
      {
        path: "/notify",
        body: {
          ladder: [{ afterHours: 24, channels: ["jira"], kind: "notify" }],
          delegations: [],
          waiting: [
            {
              ticketKey: "UGURPAY-504",
              step: "analysis",
              waitingHours: 386,
              lastActionKey: null,
            },
          ],
        },
      },
    ]);
    renderScreen(<NotifyScreen />, { fetchImpl });

    expect(await screen.findByText(/otomatik ret yok/)).toBeInTheDocument();
    // 386 hours is 16 days 2 hours — formatted through the catalog, not concatenated.
    expect(screen.getByText("16 gün 2 saat")).toBeInTheDocument();
  });
});

describe("onboard screen", () => {
  const OPTIONS = {
    path: "/onboarding/options",
    body: {
      jiraProjects: ["UGURKREDI"],
      adoRepos: ["Kredi/_git/ugurkredi"],
      platforms: ["linux-node"],
    },
  };

  it("blocks submission until a dry run has been seen", async () => {
    const { fetchImpl, calls } = stubFetch([OPTIONS]);
    renderScreen(<OnboardScreen />, { fetchImpl });

    await userEvent.selectOptions(await screen.findByLabelText("Jira projesi"), "UGURKREDI");
    await userEvent.selectOptions(screen.getByLabelText("ADO reposu"), "Kredi/_git/ugurkredi");
    await userEvent.click(screen.getByRole("button", { name: "İleri" }));
    await userEvent.selectOptions(await screen.findByLabelText("Platform profili"), "linux-node");
    await userEvent.click(screen.getByRole("button", { name: "İleri" }));
    await userEvent.click(await screen.findByRole("button", { name: "İleri" }));

    const submit = await screen.findByRole("button", { name: "Admin onayına gönder" });
    expect(submit).toBeDisabled();
    expect(await screen.findByText(/kuru koşum yapmalısın/)).toBeInTheDocument();
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  it("names the tickets that matched no rule instead of hiding them", async () => {
    const { fetchImpl } = stubFetch([
      OPTIONS,
      {
        path: "/onboarding/dry-run",
        method: "POST",
        body: { byRule: ["A-1"], bySuggestion: [], unresolved: ["UGURKREDI-3", "UGURKREDI-9"] },
      },
    ]);
    renderScreen(<OnboardScreen />, { fetchImpl });

    await userEvent.selectOptions(await screen.findByLabelText("Jira projesi"), "UGURKREDI");
    await userEvent.selectOptions(screen.getByLabelText("ADO reposu"), "Kredi/_git/ugurkredi");
    await userEvent.click(screen.getByRole("button", { name: "Kuru koşum yap" }));

    expect(await screen.findByText(/UGURKREDI-3, UGURKREDI-9/)).toBeInTheDocument();
    expect(screen.getByText("atama gerekir: 2")).toBeInTheDocument();
  });

  it("discards a stale dry run when the draft changes", async () => {
    const { fetchImpl } = stubFetch([
      OPTIONS,
      {
        path: "/onboarding/dry-run",
        method: "POST",
        body: { byRule: ["A-1"], bySuggestion: [], unresolved: [] },
      },
    ]);
    renderScreen(<OnboardScreen />, { fetchImpl });

    await userEvent.selectOptions(await screen.findByLabelText("Jira projesi"), "UGURKREDI");
    await userEvent.selectOptions(screen.getByLabelText("ADO reposu"), "Kredi/_git/ugurkredi");
    await userEvent.click(screen.getByRole("button", { name: "Kuru koşum yap" }));
    expect(await screen.findByText("kural eşleşti: 1")).toBeInTheDocument();

    // Changing the rules must invalidate the evidence gathered for the old ones.
    await userEvent.selectOptions(screen.getByLabelText("Jira projesi"), "");
    expect(await screen.findByText(/Önce Jira projesi ve repo seç/)).toBeInTheDocument();
  });
});
