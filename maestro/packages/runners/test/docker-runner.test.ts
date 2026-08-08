import { CapabilityNotSupportedError } from "@maestro/ports";
import { describe, expect, it } from "vitest";
import type { AuditRecord } from "../src/deps.js";
import { DockerLinuxRunner, TIMEOUT_EXIT_CODE } from "../src/docker-runner.js";
import { DockerHttpError, RunnerCapacityError, RunnerConfigError, RunnerLeaseError } from "../src/errors.js";
import { createDockerLinuxRunner } from "../src/register.js";
import {
  dockerRoutes,
  fakeClock,
  fakeTransport,
  FIXTURE_CONTAINER_ID,
  FIXTURES,
  type Handler,
  httpResponse,
  manualTimer,
  sequentialIds,
  TEST_CONFIG,
  TEST_JOB,
  until,
} from "./helpers.js";

interface Rig {
  runner: DockerLinuxRunner;
  requests: ReturnType<typeof fakeTransport>["requests"];
  matching: ReturnType<typeof fakeTransport>["matching"];
  audit: AuditRecord[];
  timer: ReturnType<typeof manualTimer>;
  clock: ReturnType<typeof fakeClock>;
}

function rig(overrides: Partial<Record<string, Handler>> = {}, config: object = TEST_CONFIG): Rig {
  const transport = fakeTransport(dockerRoutes(overrides));
  const clock = fakeClock();
  const timer = manualTimer();
  const audit: AuditRecord[] = [];
  const runner = createDockerLinuxRunner(config, {
    transport: transport.transport,
    clock: clock.clock,
    timer: timer.timer,
    newId: sequentialIds(),
    audit: (record) => audit.push(record),
  });
  return { runner, requests: transport.requests, matching: transport.matching, audit, timer, clock };
}

describe("acquire (M21)", () => {
  it("leases a configured linux platform", async () => {
    const { runner } = rig();

    const lease = await runner.acquire("linux-node");

    expect(lease).toEqual({ leaseId: "lease-00000001", runnerId: "docker-linux/linux-node/0", platform: "linux-node" });
  });

  it("refuses mac/win — those runners connect outbound through the agent driver (M22)", async () => {
    const { runner } = rig();

    await expect(runner.acquire("macos-xcode")).rejects.toThrow(CapabilityNotSupportedError);
    await expect(runner.acquire("windows-dotnet")).rejects.toThrow(CapabilityNotSupportedError);
  });

  it("refuses a linux platform this deployment does not serve", async () => {
    const { runner } = rig();

    await expect(runner.acquire("linux-android")).rejects.toThrow(RunnerCapacityError);
  });

  it("stops at the configured capacity instead of over-committing the host", async () => {
    const { runner } = rig({}, { ...TEST_CONFIG, platforms: { "linux-node": { image: TEST_CONFIG.platforms["linux-node"].image, capacity: 1 } } });

    await runner.acquire("linux-node");

    await expect(runner.acquire("linux-node")).rejects.toThrow(RunnerCapacityError);
  });

  it("touches the daemon for nothing — acquiring is local bookkeeping", async () => {
    const { runner, requests } = rig();

    await runner.acquire("linux-node");

    expect(requests).toHaveLength(0);
  });
});

describe("runSession happy path", () => {
  it("creates, starts, waits, tails and removes — in that order", async () => {
    const { runner, requests, clock } = rig();
    const lease = await runner.acquire("linux-node");

    const result = await runner.runSession(lease, TEST_JOB);

    expect(requests.map((request) => `${request.method} ${request.path.split("?")[0]}`)).toEqual([
      "POST /v1.44/volumes/create",
      "POST /v1.44/containers/create",
      `POST /v1.44/containers/${FIXTURE_CONTAINER_ID}/start`,
      `POST /v1.44/containers/${FIXTURE_CONTAINER_ID}/wait`,
      `GET /v1.44/containers/${FIXTURE_CONTAINER_ID}/logs`,
      `DELETE /v1.44/containers/${FIXTURE_CONTAINER_ID}`,
    ]);
    expect(result.exitCode).toBe(7);
    expect(result.stdoutTail).toBe("hello-stdout\n");
    expect(result.stderrTail).toBe("hello-stderr\n");
    expect(result.durationMs).toBe(0);
    expect(clock.clock()).toBeInstanceOf(Date);
  });

  it("sends the hardened spec, not a bare image reference", async () => {
    const { runner, matching } = rig();
    const lease = await runner.acquire("linux-node");

    await runner.runSession(lease, TEST_JOB);
    const spec = JSON.parse(matching("/containers/create")[0]?.body ?? "{}");

    expect(spec.HostConfig).toMatchObject({ ReadonlyRootfs: true, CapDrop: ["ALL"], NetworkMode: "maestro-egress" });
    expect(spec.User).toBe("10001:10001");
    expect(spec.Image).toBe(TEST_CONFIG.platforms["linux-node"].image);
  });

  it("measures duration from the injected clock", async () => {
    const { runner, clock } = rig({
      "/wait": () => {
        clock.advance(4_200);
        return FIXTURES.wait();
      },
    });
    const lease = await runner.acquire("linux-node");

    expect((await runner.runSession(lease, TEST_JOB)).durationMs).toBe(4_200);
  });

  it("truncates huge output to the configured tail", async () => {
    const frame = (stream: number, payload: string): Buffer => {
      const header = Buffer.alloc(8);
      header[0] = stream;
      header.writeUInt32BE(Buffer.byteLength(payload), 4);
      return Buffer.concat([header, Buffer.from(payload, "utf8")]);
    };
    const noisy = frame(1, "x".repeat(50_000)).toString("latin1");
    const { runner } = rig({ "/logs": () => httpResponse(200, noisy, { headers: { "Content-Type": "application/octet-stream" } }) },
      { ...TEST_CONFIG, maxTailBytes: 1_024 });
    const lease = await runner.acquire("linux-node");

    const result = await runner.runSession(lease, TEST_JOB);

    expect(result.stdoutTail.length).toBe(1_024);
  });

  it("records SANDBOX_CREATE and SANDBOX_DESTROY for the audit chain (M33)", async () => {
    const { runner, audit } = rig();
    const lease = await runner.acquire("linux-node");

    await runner.runSession(lease, TEST_JOB);

    expect(audit.map((record) => record.action)).toEqual(["SANDBOX_CREATE", "SANDBOX_DESTROY"]);
    expect(audit[0]).toMatchObject({ actor: "maestro-runner", at: "2026-08-08T14:20:00.000Z" });
    expect(audit[0]?.meta).toMatchObject({ runId: TEST_JOB.runId, networkMode: "maestro-egress" });
    expect(audit[1]?.meta).toMatchObject({ exitCode: 7, timedOut: false });
  });

  it("frees the lease for a second session but keeps the slot leased", async () => {
    const { runner } = rig();
    const lease = await runner.acquire("linux-node");

    await runner.runSession(lease, TEST_JOB);
    await expect(runner.runSession(lease, TEST_JOB)).resolves.toMatchObject({ exitCode: 7 });
    expect(runner.snapshot()[0]).toMatchObject({ leased: 1, running: 0 });
  });
});

describe("timeout (M23)", () => {
  const hangingWait: Handler = () => new Promise<never>(() => undefined);

  it("kills the container and still answers with the partial output", async () => {
    const { runner, timer, matching } = rig({ "/wait": hangingWait });
    const lease = await runner.acquire("linux-node");

    const pending = runner.runSession(lease, { ...TEST_JOB, timeoutSeconds: 30 });
    await until(() => timer.requested.length > 0, "the timeout to be armed");
    timer.fire();
    const result = await pending;

    expect(timer.requested).toEqual([30_000]);
    expect(matching("/kill")).toHaveLength(1);
    expect(matching("/kill")[0]?.path).toContain("signal=SIGKILL");
    expect(result.exitCode).toBe(TIMEOUT_EXIT_CODE);
    expect(result.stdoutTail).toBe("hello-stdout\n");
  });

  it("removes the container even when the job had to be killed", async () => {
    const { runner, timer, matching } = rig({ "/wait": hangingWait });
    const lease = await runner.acquire("linux-node");

    const pending = runner.runSession(lease, TEST_JOB);
    await until(() => timer.requested.length > 0, "the timeout to be armed");
    timer.fire();
    await pending;

    expect(matching("containers/" + FIXTURE_CONTAINER_ID).filter((r) => r.method === "DELETE")).toHaveLength(1);
  });

  it("says in the audit record that the budget, not the job, ended the run", async () => {
    const { runner, timer, audit } = rig({ "/wait": hangingWait });
    const lease = await runner.acquire("linux-node");

    const pending = runner.runSession(lease, { ...TEST_JOB, timeoutSeconds: 45 });
    await until(() => timer.requested.length > 0, "the timeout to be armed");
    timer.fire();
    await pending;

    expect(audit[1]?.meta).toMatchObject({
      timedOut: true,
      timeoutSeconds: 45,
      messageKey: "runner.session_timeout",
    });
  });

  it("cancels the timer when the job finishes first — no dangling handle", async () => {
    const { runner, timer } = rig();
    const lease = await runner.acquire("linux-node");

    await runner.runSession(lease, TEST_JOB);

    expect(timer.cancelled).toBe(1);
  });

  it("refuses a timeout above the configured ceiling instead of silently clamping it", async () => {
    const { runner, requests } = rig({}, { ...TEST_CONFIG, maxTimeoutSeconds: 600 });
    const lease = await runner.acquire("linux-node");

    await expect(runner.runSession(lease, { ...TEST_JOB, timeoutSeconds: 601 })).rejects.toThrow(/ceiling/);
    expect(requests).toHaveLength(0);
  });

  it("refuses a missing or nonsensical timeout", async () => {
    const { runner } = rig();
    const lease = await runner.acquire("linux-node");

    await expect(runner.runSession(lease, { ...TEST_JOB, timeoutSeconds: 0 })).rejects.toThrow(RunnerConfigError);
    await expect(runner.runSession(lease, { ...TEST_JOB, timeoutSeconds: 1.5 })).rejects.toThrow(RunnerConfigError);
  });
});

describe("failure handling", () => {
  it("propagates a create failure and leaves no container behind", async () => {
    const { runner, requests } = rig({ "/containers/create": () => httpResponse(404, "{\"message\":\"no such image\"}") });
    const lease = await runner.acquire("linux-node");

    await expect(runner.runSession(lease, TEST_JOB)).rejects.toThrow(DockerHttpError);
    expect(requests.filter((request) => request.method === "DELETE")).toHaveLength(0);
  });

  it("removes the container when the start fails", async () => {
    const { runner, matching } = rig({ "/start": () => httpResponse(500, "{\"message\":\"boom\"}") });
    const lease = await runner.acquire("linux-node");

    await expect(runner.runSession(lease, TEST_JOB)).rejects.toThrow(/boom/);
    expect(matching("/containers/").filter((request) => request.method === "DELETE")).toHaveLength(1);
  });

  it("frees the running flag after a failure, so the lease stays usable", async () => {
    let fail = true;
    const { runner } = rig({
      "/start": () => (fail ? httpResponse(500, "{\"message\":\"boom\"}") : FIXTURES.start()),
    });
    const lease = await runner.acquire("linux-node");

    await expect(runner.runSession(lease, TEST_JOB)).rejects.toThrow();
    fail = false;

    await expect(runner.runSession(lease, TEST_JOB)).resolves.toMatchObject({ exitCode: 7 });
  });

  it("records a failed cleanup instead of hiding an orphan container", async () => {
    const { runner, audit } = rig({ "DELETE /containers/": () => httpResponse(500, "{\"message\":\"device busy\"}") });
    const lease = await runner.acquire("linux-node");

    await runner.runSession(lease, TEST_JOB);

    expect(audit.some((record) => record.meta["removeFailed"] === true)).toBe(true);
  });

  it("degrades to empty tails when the logs cannot be read, and says so", async () => {
    const { runner, audit } = rig({ "/logs": () => httpResponse(500, "{\"message\":\"log driver\"}") });
    const lease = await runner.acquire("linux-node");

    const result = await runner.runSession(lease, TEST_JOB);

    expect(result).toMatchObject({ exitCode: 7, stdoutTail: "", stderrTail: "" });
    expect(audit.some((record) => record.meta["logsUnavailable"] === true)).toBe(true);
  });

  it("refuses a session on a released lease", async () => {
    const { runner } = rig();
    const lease = await runner.acquire("linux-node");
    await runner.release(lease);

    await expect(runner.runSession(lease, TEST_JOB)).rejects.toThrow(RunnerLeaseError);
  });

  it("refuses two concurrent sessions on one lease", async () => {
    const { runner, timer } = rig({ "/wait": () => new Promise<never>(() => undefined) });
    const lease = await runner.acquire("linux-node");

    const first = runner.runSession(lease, TEST_JOB);
    await until(() => timer.requested.length > 0, "the first session to be running");
    await expect(runner.runSession(lease, TEST_JOB)).rejects.toThrow(/busy/);

    timer.fire();
    await first;
  });
});

describe("mountCache (M31 layer ①)", () => {
  it("creates the volume and mounts it into the next session", async () => {
    const { runner, matching } = rig();
    const lease = await runner.acquire("linux-node");

    await runner.mountCache(lease, ["dep-linux-node-npm-abc123abc123"]);
    await runner.runSession(lease, TEST_JOB);

    const created = JSON.parse(matching("/volumes/create")[0]?.body ?? "{}");
    expect(created.Name).toMatch(/^maestro-cache-dep-linux-node-npm-abc123abc123-[0-9a-f]{12}$/);
    expect(created.Labels).toMatchObject({ "maestro.cache-key": "dep-linux-node-npm-abc123abc123" });

    const spec = JSON.parse(matching("/containers/create")[0]?.body ?? "{}");
    expect(spec.HostConfig.Binds).toHaveLength(2);
    // The name the volume was CREATED under must be the name that gets bound:
    // a mismatch here is a silently empty cache on every run.
    expect(spec.HostConfig.Binds[1]).toBe(`${created.Name}:/cache/dep-linux-node-npm-abc123abc123:ro`);
  });

  it("provisions the workspace volume on the configured (encrypted) driver, and binds that name", async () => {
    const { runner, matching } = rig({}, {
      ...TEST_CONFIG,
      workspace: { volumeDriver: "local", volumeOptions: { device: "/dev/mapper/maestro-crypt", type: "ext4" } },
    });
    const lease = await runner.acquire("linux-node");

    await runner.runSession(lease, TEST_JOB);
    const created = JSON.parse(matching("/volumes/create")[0]?.body ?? "{}");
    const spec = JSON.parse(matching("/containers/create")[0]?.body ?? "{}");

    expect(created).toMatchObject({
      Driver: "local",
      DriverOpts: { device: "/dev/mapper/maestro-crypt", type: "ext4" },
      Labels: { "maestro.layer": "workspace", "maestro.workspace-key": TEST_JOB.workspaceKey },
    });
    expect(spec.HostConfig.Binds[0]).toBe(`${created.Name}:/workspace:rw`);
  });

  it("removes the volume it created when the workspace is swept", async () => {
    const { runner, matching } = rig();
    const lease = await runner.acquire("linux-node");

    await runner.runSession(lease, TEST_JOB);
    const created = JSON.parse(matching("/volumes/create")[0]?.body ?? "{}");
    await runner.removeWorkspace(TEST_JOB.workspaceKey, "ticket-closed");

    const deleted = matching("/volumes/").filter((request) => request.method === "DELETE");
    expect(deleted[0]?.path).toBe(`/v1.44/volumes/${created.Name}?force=true`);
  });

  it("refuses an invalid cache key before any volume is created", async () => {
    const { runner, requests } = rig();
    const lease = await runner.acquire("linux-node");

    await expect(runner.mountCache(lease, ["../escape"])).rejects.toThrow(/invalid runner key/);
    expect(requests).toHaveLength(0);
  });

  it("bounds how many caches one job can mount", async () => {
    const { runner } = rig();
    const lease = await runner.acquire("linux-node");
    const keys = Array.from({ length: 9 }, (_, index) => `dep-${index}`);

    await expect(runner.mountCache(lease, keys)).rejects.toThrow(/at most 8/);
  });

  it("refuses to mount onto a lease that was never issued", async () => {
    const { runner } = rig();

    await expect(
      runner.mountCache({ leaseId: "ghost", runnerId: "docker-linux/linux-node/0", platform: "linux-node" }, ["dep-a"]),
    ).rejects.toThrow(RunnerLeaseError);
  });
});

describe("release and workspace lifecycle", () => {
  it("is idempotent and frees the slot", async () => {
    const { runner } = rig({}, { ...TEST_CONFIG, platforms: { "linux-node": { image: TEST_CONFIG.platforms["linux-node"].image, capacity: 1 } } });
    const lease = await runner.acquire("linux-node");

    await runner.release(lease);
    await expect(runner.release(lease)).resolves.toBeUndefined();
    await expect(runner.acquire("linux-node")).resolves.toMatchObject({ runnerId: lease.runnerId });
  });

  it("removes a workspace volume with an audit record (M31/M65)", async () => {
    const { runner, matching, audit } = rig();

    await runner.removeWorkspace("UGURPAY-1042", "ticket-closed");

    expect(matching("/volumes/")[0]?.path).toContain("force=true");
    expect(audit[0]).toMatchObject({ action: "RETENTION_ARCHIVE", meta: { workspaceKey: "UGURPAY-1042", reason: "ticket-closed" } });
  });

  it("sweeps only the workspaces past the configured age", async () => {
    const { runner, audit } = rig({}, { ...TEST_CONFIG, workspace: { maxAgeDays: 30 } });

    const swept = await runner.sweepExpiredWorkspaces([
      { workspaceKey: "UGURPAY-1", lastUsedAt: "2026-01-01T00:00:00.000Z" },
      { workspaceKey: "UGURPAY-2", lastUsedAt: "2026-08-01T00:00:00.000Z" },
    ]);

    expect(swept).toEqual(["UGURPAY-1"]);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.meta["reason"]).toBe("workspace-max-age");
  });

  it("pings the daemon through the same transport", async () => {
    const { runner } = rig();

    await expect(runner.ping()).resolves.toBe(true);
  });
});
