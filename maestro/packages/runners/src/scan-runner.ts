import { NonEmpty } from "@maestro/contracts";
import { z } from "zod";
import { DEFAULT_API_VERSION } from "./config.js";
import { type ContainerSpec, DockerClient } from "./docker-client.js";
import { RunnerConfigError } from "./errors.js";
import { createUnixSocketTransport } from "./unix-transport.js";
import type { DockerTransport } from "./deps.js";

/**
 * The scanners' container seam, bridged.
 *
 * `@maestro/scanners` asks for one thing: "run this digest-pinned image with
 * this argv against this workspace and hand back the COMPLETE report"
 * (`ContainerRunner`, RAPOR.md). `RunnerPort.runSession` could not serve it —
 * no image field, stdout tails — so every deployment shipped with
 * `unbridgedScanRunner()`, and step 6b blocked every engineering run with
 * "no ContainerRunner is wired". This is the runner: a one-shot hardened
 * container over the same Engine API the sandbox fleet uses.
 *
 * The workspace reaches the scanner one of two ways, because the path the
 * worker sees (`/workspace/runs/<id>`) means nothing to the Docker daemon:
 *  - `workspace.hostRoot`: the daemon-side path of the worker's workspace
 *    root, bound read-only (the same variable the sandbox fleet uses);
 *  - `workspace.volume`: the NAME of the volume the worker's root is, mounted
 *    read-only at a sub-path (Engine API ≥ 1.45). This is what a compose
 *    stack with a named `maestro-workspace` volume needs — no host path exists.
 */
const MountPath = z.string().regex(/^\/[A-Za-z0-9._\/-]*$/, "absolute container path");

export const ScanRunnerConfig = z
  .object({
    socketPath: NonEmpty.default("/var/run/docker.sock"),
    apiVersion: z.string().regex(/^v1\.\d{1,3}$/).default(DEFAULT_API_VERSION),
    requestTimeoutMs: z.number().int().min(100).max(300_000).default(30_000),
    labelPrefix: z.string().regex(/^[a-z0-9][a-z0-9.-]*$/).default("maestro"),
    workspace: z
      .object({
        /** The worker-side root every `workspacePath` lives under. */
        workerRoot: MountPath,
        hostRoot: MountPath.optional(),
        volume: NonEmpty.optional(),
      })
      .refine((w) => w.hostRoot !== undefined || w.volume !== undefined, {
        message: "one of workspace.hostRoot or workspace.volume is required",
      }),
    /** Read-only named volumes every scanner sees (e.g. the offline semgrep rules at /rules). */
    extraMounts: z
      .array(z.object({ volume: NonEmpty, target: MountPath }).strict())
      .default([]),
    memoryMb: z.number().int().min(256).max(65_536).default(2_048),
    pidsLimit: z.number().int().min(16).max(4_096).default(512),
    /** Writable scratch the tools need (trivy/semgrep caches) on a read-only rootfs. */
    tmpfsMb: z.number().int().min(16).max(8_192).default(1_024),
  })
  .strict();
export type ScanRunnerConfig = z.infer<typeof ScanRunnerConfig>;

/** Structural twin of `@maestro/scanners`' `ContainerRunRequest`; no package edge needed. */
export interface ScanContainerRequest {
  image: string;
  argv: readonly string[];
  workspacePath: string;
  workspaceMountPath: string;
  network: "none" | "internal";
  timeoutSeconds: number;
  env: Readonly<Record<string, string>>;
}

export interface ScanContainerOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ScanContainerRunner {
  run(request: ScanContainerRequest): Promise<ScanContainerOutput>;
}

export interface ScanRunnerDeps {
  transport?: DockerTransport;
  newId?: () => string;
  now?: () => number;
}

/** Exit code the runner reports when it had to kill the container at the deadline. */
export const SCAN_TIMEOUT_EXIT_CODE = 124;

export function createScanContainerRunner(input: unknown, deps: ScanRunnerDeps = {}): ScanContainerRunner {
  const parsed = ScanRunnerConfig.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new RunnerConfigError(`scan-runner: ${issues}`);
  }
  const config = parsed.data;
  const client = new DockerClient({
    transport: deps.transport ?? createUnixSocketTransport(config.socketPath),
    apiVersion: config.apiVersion,
    requestTimeoutMs: config.requestTimeoutMs,
  });
  const newId = deps.newId ?? (() => Math.random().toString(36).slice(2, 10));
  const now = deps.now ?? Date.now;

  return {
    async run(request) {
      const spec = buildScanSpec(config, request);
      const name = `${config.labelPrefix}-scan-${newId()}`;
      const id = await client.createContainer(name, spec);
      let timedOut = false;
      try {
        await client.startContainer(id);
        let exitCode: number;
        try {
          exitCode = await client.waitContainer(id, request.timeoutSeconds * 1_000 + 1_000);
        } catch {
          timedOut = true;
          await client.killContainer(id).catch(() => undefined);
          exitCode = SCAN_TIMEOUT_EXIT_CODE;
        }
        const logs = await client.containerLogsAll(id);
        return { exitCode, stdout: logs.stdout, stderr: logs.stderr, timedOut };
      } finally {
        await client.removeContainer(id).catch(() => undefined);
        void now;
      }
    },
  };
}

/** Where the workspace lives inside the scanner, and how it gets there. */
export function scanWorkspaceMount(
  config: ScanRunnerConfig,
  workspacePath: string,
  mountPath: string,
): { Binds?: string[]; Mounts?: Record<string, unknown>[] } {
  const root = config.workspace.workerRoot.replace(/\/+$/, "");
  const path = workspacePath.replace(/\/+$/, "");
  if (path !== root && !path.startsWith(`${root}/`)) {
    throw new RunnerConfigError(
      `scan-runner: workspace "${workspacePath}" is not under the worker root "${root}"; refusing to guess a daemon-side path`,
    );
  }
  const relative = path === root ? "" : path.slice(root.length + 1);
  if (relative.split("/").includes("..")) {
    throw new RunnerConfigError(`scan-runner: workspace "${workspacePath}" escapes the worker root`);
  }
  if (config.workspace.hostRoot !== undefined) {
    const host = `${config.workspace.hostRoot.replace(/\/+$/, "")}${relative === "" ? "" : `/${relative}`}`;
    return { Binds: [`${host}:${mountPath}:ro`] };
  }
  return {
    Mounts: [
      {
        Type: "volume",
        Source: config.workspace.volume,
        Target: mountPath,
        ReadOnly: true,
        ...(relative === "" ? {} : { VolumeOptions: { Subpath: relative } }),
      },
    ],
  };
}

const MEGABYTE = 1024 * 1024;

export function buildScanSpec(config: ScanRunnerConfig, request: ScanContainerRequest): ContainerSpec {
  const [entry, ...rest] = request.argv;
  if (entry === undefined || entry === "") throw new RunnerConfigError("scan-runner: argv is empty");
  const workspace = scanWorkspaceMount(config, request.workspacePath, request.workspaceMountPath);
  const extra = config.extraMounts.map((m) => ({ Type: "volume", Source: m.volume, Target: m.target, ReadOnly: true }));
  const mount =
    extra.length === 0
      ? workspace
      : { ...(workspace.Binds === undefined ? {} : { Binds: workspace.Binds }), Mounts: [...(workspace.Mounts ?? []), ...extra] };
  const memory = config.memoryMb * MEGABYTE;
  return {
    Image: request.image,
    // The image's own entrypoint is replaced: the scanner spec IS the command.
    Entrypoint: [entry],
    Cmd: rest,
    Env: Object.entries(request.env).map(([key, value]) => `${key}=${value}`),
    WorkingDir: request.workspaceMountPath,
    Tty: false,
    OpenStdin: false,
    AttachStdin: false,
    NetworkDisabled: request.network === "none",
    Labels: {
      [`${config.labelPrefix}.managed`]: "true",
      [`${config.labelPrefix}.purpose`]: "scan",
    },
    HostConfig: {
      ...mount,
      NetworkMode: request.network === "none" ? "none" : "bridge",
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      Privileged: false,
      Init: true,
      // Tool caches and temp files: semgrep and trivy write under /tmp and
      // $HOME; the rootfs is read-only, so both get tmpfs and HOME points there.
      Tmpfs: {
        "/tmp": `rw,nosuid,nodev,size=${String(config.tmpfsMb)}m`,
        "/root": `rw,nosuid,nodev,size=${String(config.tmpfsMb)}m`,
      },
      Memory: memory,
      MemorySwap: memory,
      PidsLimit: config.pidsLimit,
      AutoRemove: false,
    },
  };
}
