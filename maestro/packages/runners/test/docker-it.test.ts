import { describe, expect, it } from "vitest";
import { createDockerLinuxRunner, resolvePinnedImage } from "../src/register.js";
import { createUnixSocketTransport } from "../src/unix-transport.js";
import { TIMEOUT_EXIT_CODE } from "../src/docker-runner.js";

/**
 * OPT-IN smoke test against a real Docker daemon.
 *
 * The default suite never runs it and never touches a socket: it only executes
 * with `MAESTRO_DOCKER_IT=1`. Everything else in this package is covered
 * offline; this exists to prove that the hardened profile the unit tests
 * assert is a profile the Engine actually accepts — that gap is where
 * "the fixtures were green, production was not" lives.
 *
 *   MAESTRO_DOCKER_IT=1 pnpm -F @maestro/runners test
 *   MAESTRO_DOCKER_IT=1 MAESTRO_DOCKER_IT_IMAGE=alpine:3.20 pnpm -F @maestro/runners test
 *
 * The image must already be present locally (the daemon is never asked to
 * pull, and the reference is pinned to its digest before use — M27).
 */

const ENABLED = process.env["MAESTRO_DOCKER_IT"] === "1";
const SOCKET = process.env["MAESTRO_DOCKER_IT_SOCKET"] ?? "/var/run/docker.sock";
const IMAGE = process.env["MAESTRO_DOCKER_IT_IMAGE"] ?? "postgres:16-alpine";
const WORKSPACE_KEY = "MAESTRO-IT/smoke";

describe.skipIf(!ENABLED)("docker-linux smoke test (opt-in: MAESTRO_DOCKER_IT=1)", () => {
  it("runs, times out, and cleans up a real hardened container", { timeout: 180_000 }, async () => {
    const transport = createUnixSocketTransport(SOCKET);
    const image = await resolvePinnedImage(IMAGE, { transport });
    expect(image).toMatch(/sha256:[0-9a-f]{64}$/);

    const runner = createDockerLinuxRunner(
      {
        platforms: { "linux-node": { image, capacity: 1 } },
        requestTimeoutMs: 60_000,
        sandbox: { memoryMb: 256, cpus: 1, pidsLimit: 64 },
      },
      { transport },
    );

    expect(await runner.ping()).toBe(true);

    const lease = await runner.acquire("linux-node");
    try {
      // 1. A normal job: exit code and BOTH streams survive the round trip.
      const ran = await runner.runSession(lease, {
        runId: `it-${Date.now()}`,
        workspaceKey: WORKSPACE_KEY,
        command: ["/bin/sh", "-c", "id -u; echo out; echo err 1>&2; exit 3"],
        timeoutSeconds: 120,
      });

      expect(ran.exitCode).toBe(3);
      expect(ran.stdoutTail).toContain("out");
      // The profile really is non-root inside the container, not just in the spec.
      expect(ran.stdoutTail).toContain("10001");
      expect(ran.stderrTail).toContain("err");

      // 2. A job that overruns its budget is KILLED, not waited on (M23).
      const killed = await runner.runSession(lease, {
        runId: `it-timeout-${Date.now()}`,
        workspaceKey: WORKSPACE_KEY,
        command: ["/bin/sh", "-c", "sleep 300"],
        timeoutSeconds: 2,
      });

      expect(killed.exitCode).toBe(TIMEOUT_EXIT_CODE);
    } finally {
      await runner.release(lease);
      await runner.removeWorkspace(WORKSPACE_KEY, "integration-test");
    }
  });
});
