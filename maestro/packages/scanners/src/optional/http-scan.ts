import type { ScanResult, ScanSeverity, ScanTool } from "@maestro/contracts";
import type { ScanPort, ScanTarget } from "@maestro/ports";
import type { z } from "zod";
import { reasonOf } from "../container-driver.js";
import { ScanConfigError } from "../errors.js";
import type { ParsedScan } from "../parse/common.js";
import { completedResult, errorResult } from "../result.js";
import { systemClock, type Clock } from "../runner.js";
import { decideOutcome } from "../severity.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpScanSpec {
  tool: ScanTool;
  /** Fills `ScanResult.imageDigest`, which a driver without an image cannot — see RAPOR.md. */
  provenance: string;
  blockLevel: ScanSeverity;
  timeoutMs: number;
  url(target: ScanTarget): string;
  headers(): Record<string, string>;
  parse(body: string): ParsedScan;
}

export interface HttpScanPortOptions {
  spec: HttpScanSpec;
  fetchImpl?: FetchLike;
  clock?: Clock;
}

/**
 * Shared body of the optional org drivers (M77): pull a report over HTTP, map it,
 * apply the threshold. Fail-closed like the container drivers — `run()` never
 * throws and any transport, status or shape problem is `error`.
 */
export class HttpScanPort implements ScanPort {
  readonly #spec: HttpScanSpec;
  readonly #fetch: FetchLike;
  readonly #clock: Clock;

  constructor(options: HttpScanPortOptions) {
    const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
    if (!fetchImpl) throw new ScanConfigError(`${options.spec.tool}: no fetch implementation available`);
    this.#spec = options.spec;
    this.#fetch = fetchImpl;
    this.#clock = options.clock ?? systemClock;
  }

  get tool(): ScanTool {
    return this.#spec.tool;
  }

  async run(tool: ScanTool, target: ScanTarget): Promise<ScanResult> {
    const startedAt = this.#clock();
    const base = { tool: this.#spec.tool, imageDigest: this.#spec.provenance, startedAt };
    const failed = (reason: string): ScanResult =>
      errorResult({ ...base, finishedAt: this.#clock(), reason });

    if (tool !== this.#spec.tool) {
      return failed(`driver is wired for "${this.#spec.tool}" but was asked to run "${tool}"`);
    }

    let body: string;
    try {
      const response = await this.#fetch(this.#spec.url(target), {
        method: "GET",
        headers: this.#spec.headers(),
        signal: AbortSignal.timeout(this.#spec.timeoutMs),
      });
      if (!response.ok) return failed(`report request failed with HTTP ${response.status}`);
      body = await response.text();
    } catch (error) {
      return failed(`report request failed — ${reasonOf(error)}`);
    }

    try {
      const parsed = this.#spec.parse(body);
      if (parsed.fatal) return failed(parsed.fatal);
      return completedResult({
        ...base,
        finishedAt: this.#clock(),
        findings: parsed.findings,
        outcome: decideOutcome(parsed.findings, this.#spec.blockLevel),
      });
    } catch (error) {
      return failed(reasonOf(error));
    }
  }
}

/** Shared by every factory: invalid configuration is refused, never defaulted. */
export function parseConfig<T>(tool: string, schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
  throw new ScanConfigError(`${tool}: ${issues}`);
}

/** Optional drivers carry a bearer-style credential; plain http would leak it. */
export function requireHttps(tool: string, baseUrl: string): string {
  if (!/^https:\/\//i.test(baseUrl)) {
    throw new ScanConfigError(`${tool}: baseUrl "${baseUrl}" is not https — the API credential travels on this connection`);
  }
  return baseUrl.replace(/\/+$/, "");
}

/** No configuration at all means "this bank does not use the tool" (M77). */
export function isUnconfigured(input: unknown): boolean {
  return input === undefined || input === null || typeof input !== "object" || Object.keys(input).length === 0;
}
