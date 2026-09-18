import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScanContainerRunner } from "@maestro/runners";
import { createContainerScanPort } from "@maestro/scanners";
import { describe, expect, it } from "vitest";

/**
 * The whole 6b chain against real, digest-pinned scanner images: Maestro's
 * container runner → `ContainerScanPort` → parsed findings. Needs a Docker
 * daemon and the images; gated so CI without one skips, not fails.
 *   MAESTRO_IT_DOCKER=1 SCAN_IMAGE_GITLEAKS=... SCAN_IMAGE_SEMGREP=... SCAN_IMAGE_TRIVY=... vitest run test/scan-chain-it.test.ts
 */
const enabled = process.env["MAESTRO_IT_DOCKER"] === "1";
const IMAGES = {
  gitleaks: process.env["SCAN_IMAGE_GITLEAKS"] ?? "",
  semgrep: process.env["SCAN_IMAGE_SEMGREP"] ?? "",
  trivy: process.env["SCAN_IMAGE_TRIVY"] ?? "",
};

async function workspace(): Promise<{ root: string; dir: string }> {
  const root = await mkdtemp(join(tmpdir(), "maestro-scan-it-"));
  const dir = join(root, "runs", "run-1");
  await writeFile(join(root, ".keep"), "");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dir, { recursive: true });
  const token = `ghp_${"Qm7kR2pXz9LtY4vNbH3wCj8sDf6gAe1uKo5x".slice(0, 36)}`;
  await writeFile(join(dir, "app.js"), `const token = "${token}";\nconst slack = "xoxb-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx";\nconst r = eval(process.argv[2]);\nconsole.log(token, r);\n`);
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "it", version: "1.0.0", dependencies: { lodash: "4.17.20" } }));
  await writeFile(join(dir, "package-lock.json"), JSON.stringify({ name: "it", lockfileVersion: 3, packages: { "": { dependencies: { lodash: "4.17.20" } }, "node_modules/lodash": { version: "4.17.20", resolved: "https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz" } } }));
  await writeFile(join(dir, ".semgrep.yml"), await (await import("node:fs/promises")).readFile(new URL("../../../deploy/banka/tarama/semgrep-kurallar.yml", import.meta.url), "utf8"));
  return { root, dir };
}

describe.skipIf(!enabled)("6b chain on real scanner images (MAESTRO_IT_DOCKER=1)", () => {
  it("gitleaks finds the planted token through the bridged runner", async () => {
    const { root, dir } = await workspace();
    const runner = createScanContainerRunner({ workspace: { workerRoot: root, hostRoot: root } });
    const port = createContainerScanPort("gitleaks", { image: IMAGES.gitleaks }, { runner });
    const result = await port.run("gitleaks", { workspacePath: dir });
    expect(result.outcome, JSON.stringify(result.findings.slice(0, 2))).toBe("fail");
    expect(result.findings.some((f) => (f.file ?? "").endsWith("app.js"))).toBe(true);
  }, 180_000);

  it("semgrep applies the offline rules and flags eval", async () => {
    const { root, dir } = await workspace();
    const runner = createScanContainerRunner({ workspace: { workerRoot: root, hostRoot: root } });
    const port = createContainerScanPort("semgrep", { image: IMAGES.semgrep, rulesRef: "/workspace/.semgrep.yml" }, { runner });
    const result = await port.run("semgrep", { workspacePath: dir });
    expect(result.outcome, JSON.stringify(result.findings.slice(0, 2))).toBe("fail");
    expect(result.findings.some((f) => f.ruleId.includes("eval"))).toBe(true);
  }, 180_000);

  it("trivy runs offline against the lockfile and returns a parsed report", async () => {
    const { root, dir } = await workspace();
    const runner = createScanContainerRunner({
      workspace: { workerRoot: root, hostRoot: root },
      internalNetwork: "bridge",
      extraMounts: [{ volume: "maestro-it-trivy-cache", target: "/root/.cache/trivy", readOnly: false }],
    });
    // `internal` here is the test host's egress: trivy downloads its DB. A bank
    // points SCAN_INTERNAL_NETWORK at the network its DB mirror sits on.
    const port = createContainerScanPort("trivy", { image: IMAGES.trivy, networkMode: "internal", timeoutSeconds: 600 }, { runner });
    const result = await port.run("trivy", { workspacePath: dir });
    expect(result.outcome, JSON.stringify(result.findings.slice(0, 2))).toBe("fail");
    expect(result.findings.some((f) => /lodash/i.test(`${f.file} ${f.message}`))).toBe(true);
    expect(result.imageDigest).toMatch(/^sha256:/);
  }, 300_000);
});
