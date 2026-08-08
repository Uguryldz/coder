import { NonEmpty } from "@maestro/contracts";
import { z } from "zod";

/**
 * Runner configuration (M21-M27). Two rules shape this file:
 *
 * 1. **The strictest profile is the DEFAULT.** Every hardening switch defaults
 *    to on, and a config that says nothing gets a container with a read-only
 *    rootfs, no capabilities, no privilege escalation, a non-root uid, hard
 *    mem/cpu/pid limits and NO network at all.
 * 2. **Weakening is explicit and never available in production.** Turning a
 *    switch off requires naming it in `allowUnsafeProfile`, and that escape
 *    hatch is refused outright when the process runs in production (M6).
 */

export const RUNNER_PORT = "RunnerPort";
export const DOCKER_LINUX_DRIVER = "docker-linux";

/** Engine API version the client pins; see `DockerRunnerConfig.apiVersion`. */
export const DEFAULT_API_VERSION = "v1.44";

/** Platforms this driver serves. mac/win are agent-connected runners (M21/M22). */
export const LinuxPlatform = z.enum(["linux-node", "linux-android"]);
export type LinuxPlatform = z.infer<typeof LinuxPlatform>;

/**
 * Digest-pinned image reference (M27). A tag is mutable — `node:22` is a
 * different filesystem tomorrow — so the scan result stapled to an image only
 * means something if the reference is content-addressed. Both
 * `registry/repo@sha256:<64hex>` and a bare local image id are accepted.
 */
export const ImageRef = z
  .string()
  .regex(
    /^(?:[a-z0-9][a-z0-9._-]*(?::\d+)?(?:\/[a-z0-9][a-z0-9._-]*)*@)?sha256:[0-9a-f]{64}$/,
    "image must be digest-pinned: 'repo@sha256:<64 hex>' or 'sha256:<64 hex>' (M27)",
  );

/** Linux capability names an operator may add back, upper-case as Docker wants. */
const CapName = z.string().regex(/^[A-Z][A-Z0-9_]*$/);

/** The switches whose relaxation must be named one by one. */
export const UnsafeRelaxation = z.enum([
  "readonly-rootfs",
  "no-new-privileges",
  "cap-add",
  "seccomp",
  "direct-egress",
]);
export type UnsafeRelaxation = z.infer<typeof UnsafeRelaxation>;

/**
 * Deployment stage. Read from the ambient process because the hardening gate
 * must not be talked out of production by a caller-supplied value; an
 * unrecognised value is treated as production (fail-closed), unlike
 * `@maestro/config` which parses a full env for startup.
 */
export function isProductionStage(env: NodeJS.ProcessEnv = process.env): boolean {
  const stage = env.NODE_ENV;
  if (stage === undefined || stage === "") return false;
  return stage !== "development" && stage !== "test";
}

export const SandboxProfile = z.object({
  /** M23: the container filesystem is immutable; writes go to the tmpfs + volumes. */
  readonlyRootfs: z.boolean().default(true),
  noNewPrivileges: z.boolean().default(true),
  /** `uid:gid`. Root is refused unconditionally — no escape hatch (M23). */
  user: z.string().regex(/^\d+:\d+$/).default("10001:10001"),
  /** ALL capabilities are dropped first; anything here is added back explicitly. */
  capAdd: z.array(CapName).default([]),
  seccomp: z.enum(["default", "unconfined"]).default("default"),
  memoryMb: z.number().int().min(128).max(131_072).default(2_048),
  cpus: z.number().min(0.25).max(64).default(2),
  pidsLimit: z.number().int().min(16).max(8_192).default(256),
  /** Writable scratch space; noexec/nosuid/nodev are not configurable. */
  tmpfsMb: z.number().int().min(16).max(65_536).default(512),
  openFilesLimit: z.number().int().min(64).max(1_048_576).default(4_096),
  /** M23 stage 3: `runsc` (gVisor). Unset means the daemon default runtime. */
  runtime: NonEmpty.optional(),
  allowUnsafeProfile: z.array(UnsafeRelaxation).default([]),
});
export type SandboxProfile = z.infer<typeof SandboxProfile>;

/**
 * Egress (M26): a job reaches the outside world through ONE audited proxy, or
 * not at all. Configuring nothing yields `NetworkMode: none`, which is the
 * safe end of the range — an unreachable registry fails a build loudly, an
 * unmonitored direct route fails an audit silently.
 */
export const EgressConfig = z.object({
  /** Docker network that only routes to the egress proxy. */
  networkName: NonEmpty.optional(),
  proxyUrl: z.url().optional(),
  /** Hosts reachable inside the network without the proxy (registry mirror…). */
  noProxy: z.array(NonEmpty).default([]),
});
export type EgressConfig = z.infer<typeof EgressConfig>;

export const WorkspaceConfig = z.object({
  volumePrefix: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).default("maestro-ws"),
  cachePrefix: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).default("maestro-cache"),
  /**
   * M31: the ticket workspace lives on an ENCRYPTED disk. Encryption itself is
   * host provisioning (LUKS/fscrypt), but the volume must be created on it
   * deliberately — hence an explicit driver + options instead of letting a
   * bind auto-create a volume wherever the daemon's default root happens to be.
   */
  volumeDriver: NonEmpty.default("local"),
  volumeOptions: z.record(z.string(), z.string()).default({}),
  /** M65 lifecycle bound; the sweeper uses it, the driver only carries it. */
  maxAgeDays: z.number().int().min(1).max(3_650).default(60),
  /**
   * M31 layer ①: the dependency cache is shared between tickets, so a job may
   * only READ it by default; a poisoned cache would otherwise cross tickets.
   */
  cacheReadOnly: z.boolean().default(true),
});
export type WorkspaceConfig = z.infer<typeof WorkspaceConfig>;

export const PlatformSlot = z.object({
  image: ImageRef,
  capacity: z.number().int().min(1).max(64).default(1),
});
export type PlatformSlot = z.infer<typeof PlatformSlot>;

export const DockerRunnerConfig = z
  .object({
    /** Pinned Engine API version: an unpinned client silently changes shape. */
    apiVersion: z.string().regex(/^v1\.\d{1,3}$/).default(DEFAULT_API_VERSION),
    socketPath: NonEmpty.default("/var/run/docker.sock"),
    requestTimeoutMs: z.number().int().min(100).max(300_000).default(30_000),
    /** One entry per served platform; an unlisted platform is refused. */
    platforms: z.partialRecord(LinuxPlatform, PlatformSlot),
    sandbox: SandboxProfile.prefault({}),
    egress: EgressConfig.prefault({}),
    workspace: WorkspaceConfig.prefault({}),
    /** Ceiling for `RunJob.timeoutSeconds` (M23) — a larger request is refused. */
    maxTimeoutSeconds: z.number().int().min(1).max(86_400).default(3_600),
    /** How long a killed container may take to die before we stop waiting. */
    killGraceMs: z.number().int().min(100).max(60_000).default(5_000),
    /** Cap on the stdout/stderr tails handed back in `RunResult`. */
    maxTailBytes: z.number().int().min(256).max(1_048_576).default(16_384),
    labelPrefix: z.string().regex(/^[a-z0-9][a-z0-9.-]*$/).default("maestro"),
  })
  .superRefine((config, ctx) => {
    for (const issue of profileIssues(config)) {
      ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
    }
  });
export type DockerRunnerConfig = z.infer<typeof DockerRunnerConfig>;

interface ProfileIssue {
  path: (string | number)[];
  message: string;
}

/**
 * The hardening gate, kept separate from the schema so it is directly testable
 * and so the same rules can be re-checked at container build time.
 */
export function profileIssues(
  config: { sandbox: SandboxProfile; egress: EgressConfig; platforms: Record<string, unknown> },
  env: NodeJS.ProcessEnv = process.env,
): ProfileIssue[] {
  const issues: ProfileIssue[] = [];
  const { sandbox, egress } = config;
  const allowed = new Set(sandbox.allowUnsafeProfile);
  const production = isProductionStage(env);

  if (Object.keys(config.platforms).length === 0) {
    issues.push({ path: ["platforms"], message: "at least one platform must be configured" });
  }

  if (sandbox.user.startsWith("0:")) {
    issues.push({ path: ["sandbox", "user"], message: "container uid 0 is never allowed (M23) — use a non-root uid" });
  }

  const relaxations: { on: boolean; key: UnsafeRelaxation; path: (string | number)[]; what: string }[] = [
    { on: !sandbox.readonlyRootfs, key: "readonly-rootfs", path: ["sandbox", "readonlyRootfs"], what: "a writable rootfs" },
    { on: !sandbox.noNewPrivileges, key: "no-new-privileges", path: ["sandbox", "noNewPrivileges"], what: "privilege escalation" },
    { on: sandbox.capAdd.length > 0, key: "cap-add", path: ["sandbox", "capAdd"], what: "added capabilities" },
    { on: sandbox.seccomp === "unconfined", key: "seccomp", path: ["sandbox", "seccomp"], what: "an unconfined seccomp profile" },
    {
      on: egress.networkName !== undefined && egress.proxyUrl === undefined,
      key: "direct-egress",
      path: ["egress", "proxyUrl"],
      what: "a network without an egress proxy (M26)",
    },
  ];

  for (const relaxation of relaxations) {
    if (!relaxation.on) continue;
    if (production) {
      issues.push({ path: relaxation.path, message: `${relaxation.what} is refused in production (M23/M26)` });
    } else if (!allowed.has(relaxation.key)) {
      issues.push({
        path: relaxation.path,
        message: `${relaxation.what} requires allowUnsafeProfile to list "${relaxation.key}"`,
      });
    }
  }

  return issues;
}
