import { createLogger } from "@orkestra/config";
import Docker from "dockerode";
import { PassThrough } from "node:stream";

const log = createLogger("sandbox.security-scan");

// Pinned-ish image refs; prefer `latest` for MVP but should be locked in prod.
const IMG_GITLEAKS = "zricethezav/gitleaks:latest";
const IMG_SEMGREP = "returntocorp/semgrep:latest";
const IMG_TRIVY = "aquasec/trivy:latest";

const RUN_TIMEOUT_MS = 10 * 60 * 1000;

interface ScanRunOptions {
  image: string;
  cmd: string[];
  repoPath: string;
  docker: Docker;
  correlationId?: string;
}

/**
 * Run a scanner image against a repo path, collecting stdout. If the image
 * cannot be pulled/found, logs a warning and returns an empty stdout (the
 * caller should return the "no results" shape rather than failing).
 */
async function runScanner(opts: ScanRunOptions): Promise<{ stdout: string; ok: boolean }> {
  const { image, cmd, repoPath, docker, correlationId } = opts;
  const l = log.child({ image, correlationId });

  try {
    await docker.getImage(image).inspect();
  } catch {
    try {
      l.info("pulling scanner image");
      await new Promise<void>((resolve, reject) => {
        docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
          if (err) return reject(err);
          docker.modem.followProgress(stream, (e) => (e ? reject(e) : resolve()));
        });
      });
    } catch (e) {
      l.warn({ err: e }, "scanner image unavailable; skipping");
      return { stdout: "", ok: false };
    }
  }

  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const outChunks: Buffer[] = [];
  const errChunks: Buffer[] = [];
  stdout.on("data", (c) => outChunks.push(Buffer.from(c)));
  stderr.on("data", (c) => errChunks.push(Buffer.from(c)));

  let container: Docker.Container | undefined;
  const timer = setTimeout(() => {
    l.warn("scanner run timeout; killing");
    container?.kill().catch(() => {});
  }, RUN_TIMEOUT_MS);

  try {
    container = await docker.createContainer({
      Image: image,
      Cmd: cmd,
      Tty: false,
      HostConfig: {
        Binds: [`${repoPath}:/src:ro`],
        AutoRemove: true,
        NetworkMode: "bridge",
        ReadonlyRootfs: false,
        SecurityOpt: ["no-new-privileges"],
      },
      WorkingDir: "/src",
    });

    const stream = await container.attach({ stream: true, stdout: true, stderr: true });
    docker.modem.demuxStream(stream, stdout, stderr);

    await container.start();
    await container.wait();
  } catch (e) {
    l.warn({ err: e }, "scanner run failed");
    clearTimeout(timer);
    return { stdout: Buffer.concat(outChunks).toString("utf8"), ok: false };
  } finally {
    clearTimeout(timer);
  }

  const out = Buffer.concat(outChunks).toString("utf8");
  const err = Buffer.concat(errChunks).toString("utf8");
  if (err.trim()) l.debug({ stderr: err.slice(0, 2000) }, "scanner stderr");
  return { stdout: out, ok: true };
}

export interface GitleaksLeak {
  file: string;
  rule: string;
  line?: number;
  match?: string;
  secret?: string;
}

export interface GitleaksResult {
  leaks: GitleaksLeak[];
}

export async function runGitleaks(
  repoPath: string,
  docker: Docker = new Docker(),
  correlationId?: string,
): Promise<GitleaksResult> {
  const { stdout, ok } = await runScanner({
    image: IMG_GITLEAKS,
    cmd: [
      "detect",
      "--no-git",
      "--source",
      "/src",
      "--report-format",
      "json",
      "--report-path",
      "/dev/stdout",
      "--redact",
    ],
    repoPath,
    docker,
    correlationId,
  });
  if (!ok || !stdout.trim()) return { leaks: [] };

  try {
    const arr = JSON.parse(stdout) as Array<Record<string, unknown>>;
    const leaks: GitleaksLeak[] = arr.map((r) => ({
      file: String(r["File"] ?? r["file"] ?? ""),
      rule: String(r["RuleID"] ?? r["rule"] ?? ""),
      line: typeof r["StartLine"] === "number" ? (r["StartLine"] as number) : undefined,
      match: r["Match"] ? String(r["Match"]) : undefined,
      secret: r["Secret"] ? String(r["Secret"]) : undefined,
    }));
    return { leaks };
  } catch (e) {
    log.warn({ err: e }, "gitleaks json parse failed");
    return { leaks: [] };
  }
}

export interface SemgrepFinding {
  checkId: string;
  path: string;
  start?: { line?: number; col?: number };
  end?: { line?: number; col?: number };
  severity: string;
  message: string;
}

export interface SemgrepResult {
  findings: SemgrepFinding[];
}

export async function runSemgrep(
  repoPath: string,
  configs: string[] = ["p/security-audit", "p/owasp-top-ten"],
  docker: Docker = new Docker(),
  correlationId?: string,
): Promise<SemgrepResult> {
  const cfgArgs = configs.flatMap((c) => ["--config", c]);
  const { stdout, ok } = await runScanner({
    image: IMG_SEMGREP,
    cmd: ["semgrep", "--json", "--quiet", ...cfgArgs, "/src"],
    repoPath,
    docker,
    correlationId,
  });
  if (!ok || !stdout.trim()) return { findings: [] };

  try {
    const parsed = JSON.parse(stdout) as { results?: Array<Record<string, any>> };
    const findings: SemgrepFinding[] = (parsed.results ?? []).map((r) => ({
      checkId: String(r["check_id"] ?? ""),
      path: String(r["path"] ?? ""),
      start: r["start"],
      end: r["end"],
      severity: String(r["extra"]?.severity ?? "INFO"),
      message: String(r["extra"]?.message ?? ""),
    }));
    return { findings };
  } catch (e) {
    log.warn({ err: e }, "semgrep json parse failed");
    return { findings: [] };
  }
}

export interface TrivyVuln {
  pkg: string;
  installedVersion: string;
  fixedVersion?: string;
  vulnerabilityId: string;
  severity: string;
  title: string;
}

export interface TrivyResult {
  vulnerabilities: TrivyVuln[];
}

export async function runTrivy(
  repoPath: string,
  docker: Docker = new Docker(),
  correlationId?: string,
): Promise<TrivyResult> {
  const { stdout, ok } = await runScanner({
    image: IMG_TRIVY,
    cmd: ["fs", "--quiet", "--format", "json", "--scanners", "vuln", "/src"],
    repoPath,
    docker,
    correlationId,
  });
  if (!ok || !stdout.trim()) return { vulnerabilities: [] };

  try {
    const parsed = JSON.parse(stdout) as {
      Results?: Array<{ Vulnerabilities?: Array<Record<string, any>> }>;
    };
    const vulns: TrivyVuln[] = [];
    for (const res of parsed.Results ?? []) {
      for (const v of res.Vulnerabilities ?? []) {
        vulns.push({
          pkg: String(v["PkgName"] ?? ""),
          installedVersion: String(v["InstalledVersion"] ?? ""),
          fixedVersion: v["FixedVersion"] ? String(v["FixedVersion"]) : undefined,
          vulnerabilityId: String(v["VulnerabilityID"] ?? ""),
          severity: String(v["Severity"] ?? "UNKNOWN"),
          title: String(v["Title"] ?? ""),
        });
      }
    }
    return { vulnerabilities: vulns };
  } catch (e) {
    log.warn({ err: e }, "trivy json parse failed");
    return { vulnerabilities: [] };
  }
}
