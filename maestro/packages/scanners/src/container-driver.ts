import type { ScanResult, ScanTool } from "@maestro/contracts";
import type { ScanPort, ScanTarget } from "@maestro/ports";
import type { ContainerScanConfig, CoreScanTool } from "./config.js";
import { parsePinnedImage, type PinnedImage } from "./image.js";
import { completedResult, errorResult } from "./result.js";
import { systemClock, type Clock, type ContainerRunner, type ContainerRunOutput } from "./runner.js";
import { decideOutcome } from "./severity.js";
import type { ToolSpec } from "./tools.js";

export interface ContainerScanPortOptions {
  spec: ToolSpec;
  config: ContainerScanConfig;
  runner: ContainerRunner;
  clock?: Clock;
}

/**
 * ScanPort driver that runs one tool in a digest-pinned container (M27).
 *
 * Invariant: `run()` NEVER throws and NEVER returns `pass` unless the tool
 * started, exited with a code that means "completed" and produced a report this
 * package could parse in full. Every other path — image rejected, runner threw,
 * timeout, unexpected exit code, unparseable or schema-violating output,
 * tool-reported error — is `outcome: "error"`, which `isScanBlocking` blocks on.
 */
export class ContainerScanPort implements ScanPort {
  readonly #spec: ToolSpec;
  readonly #config: ContainerScanConfig;
  readonly #image: PinnedImage;
  readonly #runner: ContainerRunner;
  readonly #clock: Clock;

  constructor(options: ContainerScanPortOptions) {
    // Both throw ScanConfigError, at wiring time, before anything can run.
    this.#image = parsePinnedImage(options.config.image);
    options.spec.validate(options.config);
    this.#spec = options.spec;
    this.#config = options.config;
    this.#runner = options.runner;
    this.#clock = options.clock ?? systemClock;
  }

  get tool(): CoreScanTool {
    return this.#spec.tool;
  }

  get imageDigest(): string {
    return this.#image.digest;
  }

  async run(tool: ScanTool, target: ScanTarget): Promise<ScanResult> {
    const startedAt = this.#clock();
    const base = { tool: this.#spec.tool, imageDigest: this.#image.digest, startedAt };
    const failed = (reason: string): ScanResult =>
      errorResult({ ...base, finishedAt: this.#clock(), reason });

    if (tool !== this.#spec.tool) {
      return failed(`driver is wired for "${this.#spec.tool}" but was asked to run "${tool}"`);
    }
    if (!target?.workspacePath?.trim()) return failed("target.workspacePath is empty");

    let argv: string[];
    try {
      argv = this.#spec.argv(this.#config, target);
    } catch (error) {
      return failed(`command could not be built — ${reasonOf(error)}`);
    }

    let output: ContainerRunOutput;
    try {
      output = await this.#runner.run({
        image: this.#image.ref,
        argv,
        workspacePath: target.workspacePath,
        workspaceMountPath: this.#config.workspaceMountPath,
        network: this.#config.networkMode,
        timeoutSeconds: this.#config.timeoutSeconds,
        env: this.#config.env,
      });
    } catch (error) {
      return failed(`container run failed — ${reasonOf(error)}`);
    }

    if (!output || typeof output.exitCode !== "number" || typeof output.stdout !== "string") return failed("runner returned an unusable result");
    if (output.timedOut) return failed(`timed out after ${this.#config.timeoutSeconds}s`);
    if (!this.#spec.okExitCodes.includes(output.exitCode)) {
      return failed(`exited with code ${output.exitCode}${this.#stderr(output)}`);
    }

    try {
      const parsed = this.#spec.parse(output.stdout, this.#config);
      if (parsed.fatal) return failed(parsed.fatal);
      return completedResult({
        ...base,
        finishedAt: this.#clock(),
        findings: parsed.findings,
        outcome: decideOutcome(parsed.findings, this.#config.blockLevel),
      });
    } catch (error) {
      return failed(reasonOf(error));
    }
  }

  /** Opt-in only: tool stderr can echo the matched secret (see config). */
  #stderr(output: ContainerRunOutput): string {
    if (!this.#config.includeStderrInError) return "";
    const tail = output.stderr?.trim().slice(-200);
    return tail ? ` — ${tail}` : "";
  }
}

export function reasonOf(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
