import { describe, expect, it } from "vitest";
import { buildScanSpec, createScanContainerRunner, SCAN_TIMEOUT_EXIT_CODE, ScanRunnerConfig, scanWorkspaceMount } from "../src/scan-runner.js";
import { fakeTransport, httpResponse } from "./helpers.js";

const frame = (stream: number, payload: string): Buffer => {
  const bytes = Buffer.from(payload, "utf8");
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(bytes.byteLength, 4);
  return Buffer.concat([header, bytes]);
};

function logsBody(stdout: string, stderr: string): Uint8Array {
  const body = Buffer.concat([frame(1, stdout), frame(2, stderr)]);
  const head = ["HTTP/1.1 200 OK", "Content-Type: application/vnd.docker.raw-stream", `Content-Length: ${String(body.byteLength)}`, "", ""].join("\r\n");
  return Buffer.concat([Buffer.from(head, "utf8"), body]);
}

const VOLUME_CONFIG = { socketPath: "/var/run/docker.sock", workspace: { workerRoot: "/workspace", volume: "maestro_maestro-workspace" } };
const HOST_CONFIG = { socketPath: "/var/run/docker.sock", workspace: { workerRoot: "/workspace", hostRoot: "/srv/maestro/workspace" } };

const request = {
  image: "ghcr.io/x/gitleaks@sha256:" + "a".repeat(64),
  argv: ["gitleaks", "dir", "/src", "--report-format", "json"],
  workspacePath: "/workspace/runs/run-1",
  workspaceMountPath: "/src",
  network: "none" as const,
  timeoutSeconds: 60,
  env: { GITLEAKS_CONFIG: "/src/.gitleaks.toml" },
};

describe("scanWorkspaceMount", () => {
  it("binds a host sub-path read-only when the host root is known", () => {
    const config = ScanRunnerConfig.parse(HOST_CONFIG);
    expect(scanWorkspaceMount(config, "/workspace/runs/run-1", "/src")).toEqual({ Binds: ["/srv/maestro/workspace/runs/run-1:/src:ro"] });
  });

  it("mounts the named volume at a sub-path when the workspace is a volume", () => {
    const config = ScanRunnerConfig.parse(VOLUME_CONFIG);
    expect(scanWorkspaceMount(config, "/workspace/runs/run-1/", "/src")).toEqual({
      Mounts: [{ Type: "volume", Source: "maestro_maestro-workspace", Target: "/src", ReadOnly: true, VolumeOptions: { Subpath: "runs/run-1" } }],
    });
  });

  it("refuses a workspace outside the worker root or escaping it", () => {
    const config = ScanRunnerConfig.parse(VOLUME_CONFIG);
    expect(() => scanWorkspaceMount(config, "/etc", "/src")).toThrow(/not under the worker root/);
    expect(() => scanWorkspaceMount(config, "/workspace/runs/../../etc", "/src")).toThrow(/escapes|not under/);
  });

  it("needs one of hostRoot or volume", () => {
    expect(() => ScanRunnerConfig.parse({ workspace: { workerRoot: "/workspace" } })).toThrow(/hostRoot or workspace.volume/);
  });
});

describe("buildScanSpec", () => {
  it("replaces the entrypoint, disables the network and hardens the container", () => {
    const spec = buildScanSpec(ScanRunnerConfig.parse(VOLUME_CONFIG), request);
    expect(spec.Image).toBe(request.image);
    expect(spec.Entrypoint).toEqual(["gitleaks"]);
    expect(spec.Cmd).toEqual(["dir", "/src", "--report-format", "json"]);
    expect(spec.Env).toEqual(["GITLEAKS_CONFIG=/src/.gitleaks.toml"]);
    expect(spec.NetworkDisabled).toBe(true);
    const host = spec.HostConfig as Record<string, unknown>;
    expect(host.NetworkMode).toBe("none");
    expect(host.ReadonlyRootfs).toBe(true);
    expect(host.CapDrop).toEqual(["ALL"]);
    expect(host.SecurityOpt).toEqual(["no-new-privileges:true"]);
    expect(host.PidsLimit).toBe(512);
    expect(host.Memory).toBe(2048 * 1024 * 1024);
    expect(host.Mounts).toBeDefined();
  });
});

describe("createScanContainerRunner", () => {
  it("creates, starts, waits, returns the COMPLETE logs and removes the container", async () => {
    const fake = fakeTransport(async (req) => {
      if (req.path.includes("/containers/create")) return httpResponse(201, JSON.stringify({ Id: "c1" }));
      if (req.path.includes("/start")) return httpResponse(204);
      if (req.path.includes("/wait")) return httpResponse(200, JSON.stringify({ StatusCode: 1 }));
      if (req.path.includes("/logs")) return logsBody('{"findings":[]}\n', "warn: x\n");
      if (req.method === "DELETE") return httpResponse(204);
      return httpResponse(500, "unexpected " + req.path);
    });
    const runner = createScanContainerRunner(VOLUME_CONFIG, { transport: fake.transport, newId: () => "abc" });
    const out = await runner.run(request);
    expect(out).toEqual({ exitCode: 1, stdout: '{"findings":[]}\n', stderr: "warn: x\n", timedOut: false });
    expect(fake.requests.map((r) => `${r.method} ${r.path.replace(/^\/v1\.\d+/, "")}`)).toEqual([
      "POST /containers/create?name=maestro-scan-abc",
      "POST /containers/c1/start",
      "POST /containers/c1/wait",
      "GET /containers/c1/logs?stdout=1&stderr=1&tail=all",
      "DELETE /containers/c1?force=true&v=false",
    ]);
    const created = JSON.parse(fake.requests[0]?.body ?? "{}") as { HostConfig: { Mounts: unknown[] } };
    expect(created.HostConfig.Mounts).toHaveLength(1);
  });

  it("kills the container and reports timedOut when the wait passes the deadline", async () => {
    const fake = fakeTransport(async (req) => {
      if (req.path.includes("/containers/create")) return httpResponse(201, JSON.stringify({ Id: "c2" }));
      if (req.path.includes("/start")) return httpResponse(204);
      if (req.path.includes("/wait")) throw new Error("socket timeout");
      if (req.path.includes("/kill")) return httpResponse(204);
      if (req.path.includes("/logs")) return logsBody("partial", "");
      if (req.method === "DELETE") return httpResponse(204);
      return httpResponse(500);
    });
    const runner = createScanContainerRunner(HOST_CONFIG, { transport: fake.transport });
    const out = await runner.run(request);
    expect(out.timedOut).toBe(true);
    expect(out.exitCode).toBe(SCAN_TIMEOUT_EXIT_CODE);
    expect(fake.matching("/kill")).toHaveLength(1);
    expect(fake.requests.at(-1)?.method).toBe("DELETE");
  });

  it("removes the container even when start fails", async () => {
    const fake = fakeTransport(async (req) => {
      if (req.path.includes("/containers/create")) return httpResponse(201, JSON.stringify({ Id: "c3" }));
      if (req.path.includes("/start")) return httpResponse(500, JSON.stringify({ message: "no such image" }));
      if (req.method === "DELETE") return httpResponse(204);
      return httpResponse(500);
    });
    const runner = createScanContainerRunner(HOST_CONFIG, { transport: fake.transport });
    await expect(runner.run(request)).rejects.toThrow(/no such image/);
    expect(fake.requests.at(-1)?.method).toBe("DELETE");
  });
});
