import type { RunJob } from "@maestro/ports";
import type { DockerRunnerConfig, EgressConfig } from "./config.js";
import { ImageRef, profileIssues } from "./config.js";
import type { ContainerSpec } from "./docker-client.js";
import { RunnerConfigError } from "./errors.js";
import {
  assertCacheKey,
  cacheMountPath,
  cacheVolumeName,
  WORKSPACE_MOUNT_PATH,
  workspaceVolumeName,
} from "./workspace.js";

/**
 * The hardened container profile (M23/M24/M26/M27), as ONE pure function from
 * configuration + job to the Docker create payload. Pure on purpose: the
 * profile is a security control, and a security control that can only be
 * observed by starting a container cannot be unit-tested.
 */

const NANO_CPUS = 1_000_000_000;
const MEGABYTE = 1_024 * 1_024;

/** Proxy variables the platform owns; a job may not override them (M26). */
export const RESERVED_ENV_NAMES = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"];

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Loaders that turn an environment variable into code execution inside the
 * sandbox before the job's own command runs. They are refused outright: the
 * point of the profile is that the command is what the workflow asked for.
 */
const FORBIDDEN_ENV_NAMES = ["LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT", "NODE_OPTIONS", "BASH_ENV"];

export interface SandboxInput {
  config: DockerRunnerConfig;
  image: string;
  job: RunJob;
  leaseId: string;
  platform: string;
  cacheKeys: readonly string[];
}

/** `NetworkMode` for the job. No egress configuration means NO network (M26). */
export function egressNetworkMode(egress: EgressConfig): string {
  return egress.networkName ?? "none";
}

/** Deterministic, collision-free container name — the audit trail points at it. */
export function containerName(config: DockerRunnerConfig, job: RunJob, leaseId: string): string {
  const slug = `${job.runId}-${leaseId}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `${config.labelPrefix}-${slug}`.slice(0, 63);
}

/**
 * Job environment + the platform's egress variables. Fails closed on anything
 * a job should not be able to say; the proxy settings are appended LAST so
 * they are the effective values even if the checks above ever loosen.
 */
export function sandboxEnv(config: DockerRunnerConfig, job: RunJob): string[] {
  const env: string[] = [`HOME=${WORKSPACE_MOUNT_PATH}`, `MAESTRO_RUN_ID=${job.runId}`];
  for (const [name, value] of Object.entries(job.env ?? {})) {
    if (!ENV_NAME.test(name)) throw new RunnerConfigError(`environment variable name "${name}" is not a valid name`);
    if (RESERVED_ENV_NAMES.includes(name)) {
      throw new RunnerConfigError(`environment variable "${name}" is owned by the egress policy (M26)`);
    }
    if (FORBIDDEN_ENV_NAMES.includes(name)) {
      throw new RunnerConfigError(`environment variable "${name}" can inject code into the sandbox — refused`);
    }
    if (value.includes("\0")) throw new RunnerConfigError(`environment variable "${name}" contains a NUL byte`);
    env.push(`${name}=${value}`);
  }
  const { proxyUrl, noProxy } = config.egress;
  if (proxyUrl !== undefined) {
    env.push(`HTTP_PROXY=${proxyUrl}`, `HTTPS_PROXY=${proxyUrl}`, `http_proxy=${proxyUrl}`, `https_proxy=${proxyUrl}`);
    const skip = ["localhost", "127.0.0.1", ...noProxy].join(",");
    env.push(`NO_PROXY=${skip}`, `no_proxy=${skip}`);
  }
  return env;
}

/** Volume binds: workspace (M31 layer ②, rw) + dependency caches (layer ①, ro). */
export function sandboxBinds(config: DockerRunnerConfig, job: RunJob, cacheKeys: readonly string[]): string[] {
  const workspace = workspaceVolumeName(job.workspaceKey, config.workspace.volumePrefix);
  const binds = [`${workspace}:${WORKSPACE_MOUNT_PATH}:rw`];
  for (const key of cacheKeys) {
    assertCacheKey(key);
    const mode = config.workspace.cacheReadOnly ? "ro" : "rw";
    binds.push(`${cacheVolumeName(key, config.workspace.cachePrefix)}:${cacheMountPath(key)}:${mode}`);
  }
  return binds;
}

export function buildContainerSpec(input: SandboxInput): ContainerSpec {
  const { config, job } = input;
  const { sandbox } = config;

  // The gate runs again here, not only in the schema: a profile assembled in
  // code (tests, a future admin API) must not be able to skip it.
  const issues = profileIssues(config);
  if (issues.length > 0) {
    throw new RunnerConfigError(issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  if (!ImageRef.safeParse(input.image).success) {
    throw new RunnerConfigError(`image "${input.image}" is not digest-pinned (M27)`);
  }
  if (job.command.length === 0) throw new RunnerConfigError("job command is empty");

  // `SecurityOpt` has no literal for "the daemon's default seccomp profile":
  // Docker parses any other `seccomp=` value as a profile document and refuses
  // to start (verified against Engine 29.4 — fixtures/containers-start*.http).
  // Saying nothing is therefore what keeps the default filter ON.
  const securityOpt = sandbox.seccomp === "unconfined" ? ["seccomp=unconfined"] : [];
  if (sandbox.noNewPrivileges) securityOpt.unshift("no-new-privileges:true");

  const memoryBytes = sandbox.memoryMb * MEGABYTE;
  const labels: Record<string, string> = {
    [`${config.labelPrefix}.managed`]: "true",
    [`${config.labelPrefix}.run-id`]: job.runId,
    [`${config.labelPrefix}.lease-id`]: input.leaseId,
    [`${config.labelPrefix}.platform`]: input.platform,
    [`${config.labelPrefix}.workspace`]: workspaceVolumeName(job.workspaceKey, config.workspace.volumePrefix),
  };

  return {
    Image: input.image,
    Cmd: [...job.command],
    Entrypoint: [],
    User: sandbox.user,
    Env: sandboxEnv(config, job),
    WorkingDir: WORKSPACE_MOUNT_PATH,
    Tty: false,
    OpenStdin: false,
    AttachStdin: false,
    NetworkDisabled: egressNetworkMode(config.egress) === "none",
    Labels: labels,
    HostConfig: {
      Binds: sandboxBinds(config, job, input.cacheKeys),
      NetworkMode: egressNetworkMode(config.egress),
      ReadonlyRootfs: sandbox.readonlyRootfs,
      CapDrop: ["ALL"],
      CapAdd: [...sandbox.capAdd],
      SecurityOpt: securityOpt,
      Privileged: false,
      Init: true,
      // `size=` keeps a runaway `dd` inside the tmpfs from eating host RAM.
      Tmpfs: { "/tmp": `rw,noexec,nosuid,nodev,size=${sandbox.tmpfsMb}m` },
      Memory: memoryBytes,
      // Equal to `Memory` = swap disabled: a memory limit that can swap is a
      // suggestion, not a limit.
      MemorySwap: memoryBytes,
      NanoCpus: Math.round(sandbox.cpus * NANO_CPUS),
      PidsLimit: sandbox.pidsLimit,
      Ulimits: [{ Name: "nofile", Soft: sandbox.openFilesLimit, Hard: sandbox.openFilesLimit }],
      AutoRemove: false,
      RestartPolicy: { Name: "no" },
      ...(sandbox.runtime === undefined ? {} : { Runtime: sandbox.runtime }),
      LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } },
    },
  };
}
