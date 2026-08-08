import type { ScanTarget } from "@maestro/ports";
import type { ContainerScanConfig, CoreScanTool } from "./config.js";
import { ScanConfigError } from "./errors.js";
import { parseGitleaks } from "./parse/gitleaks.js";
import { parseSemgrep } from "./parse/semgrep.js";
import { parseTrivy } from "./parse/trivy.js";
import type { ParsedScan } from "./parse/common.js";

export interface ToolSpec {
  tool: CoreScanTool;
  /**
   * Codes meaning "ran to completion". ANY other code is an `error` outcome even
   * when stdout happens to parse (M27): a half-dead scanner cleared nothing.
   */
  okExitCodes: readonly number[];
  /** Throws `ScanConfigError` for a target the tool cannot be pointed at. */
  argv(config: ContainerScanConfig, target: ScanTarget): string[];
  parse(stdout: string, config: ContainerScanConfig): ParsedScan;
  /** Factory-time check; runs before any container is started. */
  validate(config: ContainerScanConfig): void;
}

/** Refuses anything that could be read as a flag or a shell escape. */
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function gitRef(target: ScanTarget): string | undefined {
  const ref = target.diffBaseRef?.trim();
  if (!ref) return undefined;
  if (!SAFE_REF.test(ref)) throw new ScanConfigError(`diffBaseRef "${ref}" is not a plain git ref`);
  return ref;
}

const gitleaks: ToolSpec = {
  tool: "gitleaks",
  // 0 = clean, 1 = leaks found (gitleaks' default --exit-code), 2 = tool error.
  okExitCodes: [0, 1],
  argv(config, target) {
    const ref = gitRef(target);
    const scope = ref ? ["--log-opts", `${ref}..HEAD`] : ["--no-git"];
    return ["gitleaks", "detect", "--source", config.workspaceMountPath, ...scope,
      "--report-format", "json", "--report-path", "/dev/stdout", ...config.extraArgs];
  },
  parse: (stdout, config) => parseGitleaks(stdout, { secretSeverity: config.secretSeverity }),
  validate: () => undefined,
};

const semgrep: ToolSpec = {
  tool: "semgrep",
  // 0 = no findings, 1 = findings, 2 = fatal error.
  okExitCodes: [0, 1],
  argv(config, target) {
    const ref = gitRef(target);
    return ["semgrep", "scan", "--json", "--quiet", "--metrics=off", "--config", config.rulesRef ?? "",
      ...(ref ? ["--baseline-commit", ref] : []), ...config.extraArgs, config.workspaceMountPath];
  },
  parse: (stdout) => parseSemgrep(stdout),
  validate(config) {
    if (!config.rulesRef) {
      throw new ScanConfigError("semgrep: rulesRef is required — rules are pinned locally, never fetched at scan time");
    }
  },
};

const trivy: ToolSpec = {
  tool: "trivy",
  // trivy exits 0 whatever it finds unless --exit-code is passed; anything else
  // is a failed run.
  okExitCodes: [0],
  argv(config) {
    return ["trivy", "fs", "--format", "json", "--quiet", "--scanners", "vuln",
      ...config.extraArgs, config.workspaceMountPath];
  },
  parse: (stdout) => parseTrivy(stdout),
  validate: () => undefined,
};

export const TOOL_SPECS: Record<CoreScanTool, ToolSpec> = { gitleaks, semgrep, trivy };
