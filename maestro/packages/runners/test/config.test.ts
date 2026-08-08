import { afterEach, describe, expect, it } from "vitest";
import {
  DockerRunnerConfig,
  ImageRef,
  isProductionStage,
  profileIssues,
  SandboxProfile,
} from "../src/config.js";
import { TEST_CONFIG, TEST_IMAGE } from "./helpers.js";

const AMBIENT = process.env.NODE_ENV;
afterEach(() => {
  process.env.NODE_ENV = AMBIENT;
});

function withStage<T>(stage: string | undefined, body: () => T): T {
  const previous = process.env.NODE_ENV;
  if (stage === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = stage;
  try {
    return body();
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
}

describe("the default profile is the strictest one (M23)", () => {
  it("hardens everything a config that says nothing", () => {
    const sandbox = SandboxProfile.parse({});

    expect(sandbox).toMatchObject({
      readonlyRootfs: true,
      noNewPrivileges: true,
      user: "10001:10001",
      capAdd: [],
      seccomp: "default",
      allowUnsafeProfile: [],
    });
    expect(sandbox.memoryMb).toBe(2_048);
    expect(sandbox.pidsLimit).toBe(256);
    expect(sandbox.cpus).toBe(2);
    expect(sandbox.tmpfsMb).toBe(512);
  });

  it("gives a minimal config a NO-network default — nothing leaves without a proxy (M26)", () => {
    const config = DockerRunnerConfig.parse({ platforms: { "linux-node": { image: TEST_IMAGE } } });

    expect(config.egress.networkName).toBeUndefined();
    expect(config.egress.proxyUrl).toBeUndefined();
    expect(config.workspace.cacheReadOnly).toBe(true);
    expect(config.workspace.maxAgeDays).toBe(60);
    expect(config.maxTimeoutSeconds).toBe(3_600);
    expect(config.platforms["linux-node"]?.capacity).toBe(1);
  });

  it("rejects a config with no platform at all", () => {
    expect(DockerRunnerConfig.safeParse({ platforms: {} }).success).toBe(false);
  });

  it("rejects unknown platforms — mac/win are served by the agent driver (M21)", () => {
    const parsed = DockerRunnerConfig.safeParse({ platforms: { "macos-xcode": { image: TEST_IMAGE } } });

    expect(parsed.success).toBe(false);
  });

  it("caps the limits so a typo cannot hand a job the whole host", () => {
    const over = { platforms: { "linux-node": { image: TEST_IMAGE } }, sandbox: { memoryMb: 999_999 } };

    expect(DockerRunnerConfig.safeParse(over).success).toBe(false);
    expect(SandboxProfile.safeParse({ cpus: 128 }).success).toBe(false);
    expect(SandboxProfile.safeParse({ pidsLimit: 100_000 }).success).toBe(false);
  });
});

describe("digest pinning (M27)", () => {
  it("accepts a repo@sha256 reference and a bare image id", () => {
    expect(ImageRef.safeParse(TEST_IMAGE).success).toBe(true);
    expect(ImageRef.safeParse(`sha256:${"c".repeat(64)}`).success).toBe(true);
    expect(ImageRef.safeParse(`registry.bank:5000/team/img@sha256:${"d".repeat(64)}`).success).toBe(true);
  });

  it("refuses every mutable reference", () => {
    for (const mutable of ["node:22", "node:22-alpine", "node", "registry/team/node:latest", "node@sha256:short"]) {
      expect(ImageRef.safeParse(mutable).success).toBe(false);
    }
  });
});

describe("weakening the profile is explicit, and impossible in production", () => {
  it("refuses a relaxation that is not named in allowUnsafeProfile", () => {
    const config = { ...TEST_CONFIG, sandbox: { readonlyRootfs: false } };

    withStage("test", () => {
      const parsed = DockerRunnerConfig.safeParse(config);
      expect(parsed.success).toBe(false);
      expect(JSON.stringify(parsed.error?.issues)).toContain("allowUnsafeProfile");
    });
  });

  it("accepts it once the operator names it, outside production", () => {
    withStage("development", () => {
      const parsed = DockerRunnerConfig.safeParse({
        ...TEST_CONFIG,
        sandbox: { readonlyRootfs: false, allowUnsafeProfile: ["readonly-rootfs"] },
      });
      expect(parsed.success).toBe(true);
    });
  });

  it("closes the escape hatch in production for every switch", () => {
    const relaxations = [
      { sandbox: { readonlyRootfs: false, allowUnsafeProfile: ["readonly-rootfs"] } },
      { sandbox: { noNewPrivileges: false, allowUnsafeProfile: ["no-new-privileges"] } },
      { sandbox: { capAdd: ["SYS_ADMIN"], allowUnsafeProfile: ["cap-add"] } },
      { sandbox: { seccomp: "unconfined", allowUnsafeProfile: ["seccomp"] } },
    ];

    withStage("production", () => {
      for (const relaxation of relaxations) {
        expect(DockerRunnerConfig.safeParse({ ...TEST_CONFIG, ...relaxation }).success).toBe(false);
      }
      expect(DockerRunnerConfig.safeParse(TEST_CONFIG).success).toBe(true);
    });
  });

  it("never allows uid 0 — not even with the escape hatch, not even in dev", () => {
    withStage("development", () => {
      const parsed = DockerRunnerConfig.safeParse({
        ...TEST_CONFIG,
        sandbox: { user: "0:0", allowUnsafeProfile: ["readonly-rootfs", "no-new-privileges", "cap-add", "seccomp"] },
      });

      expect(parsed.success).toBe(false);
      expect(JSON.stringify(parsed.error?.issues)).toContain("uid 0");
    });
  });

  it("refuses a network without an egress proxy — unmonitored egress (M26)", () => {
    withStage("test", () => {
      const parsed = DockerRunnerConfig.safeParse({
        platforms: TEST_CONFIG.platforms,
        egress: { networkName: "bridge" },
      });

      expect(parsed.success).toBe(false);
      expect(JSON.stringify(parsed.error?.issues)).toContain("direct-egress");
    });
  });

  it("treats an unrecognised NODE_ENV as production (fail-closed)", () => {
    expect(withStage("prod", isProductionStage)).toBe(true);
    expect(withStage("staging", isProductionStage)).toBe(true);
    expect(withStage("Production", isProductionStage)).toBe(true);
    expect(withStage("development", isProductionStage)).toBe(false);
    expect(withStage("test", isProductionStage)).toBe(false);
    expect(withStage(undefined, isProductionStage)).toBe(false);
  });

  it("reports every offending switch at once, not just the first", () => {
    const issues = profileIssues(
      {
        platforms: { "linux-node": {} },
        sandbox: SandboxProfile.parse({ readonlyRootfs: false, noNewPrivileges: false, capAdd: ["SYS_ADMIN"] }),
        egress: { noProxy: [] },
      },
      { NODE_ENV: "test" },
    );

    expect(issues).toHaveLength(3);
  });
});
