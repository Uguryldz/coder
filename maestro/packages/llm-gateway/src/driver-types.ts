import type { ApiDriverId } from "@maestro/contracts";
import type { SecretPort } from "@maestro/ports";
import type { RetryConfig } from "./config.js";
import type { CallCounter, HttpDeps, TokenBucket } from "./http.js";

export interface DriverCall {
  model: string;
  system: string | null;
  prompt: string;
  maxTokens: number;
  temperature: number;
  /**
   * Overrides the driver's own key reference — a subscription seat carries its
   * own credential while riding the same transport (M55).
   */
  credentialRef?: string;
  /** Counts the physical attempts this call costs, so quota can burn them (M55). */
  counter?: CallCounter;
}

export interface DriverResult {
  text: string;
  tokensIn: number;
  tokensOut: number;
  /** Share of input tokens served from the prompt cache; null when unreported. */
  cachePct: number | null;
}

/** The single shape all four API drivers implement (M16). */
export interface LlmDriver {
  readonly id: ApiDriverId;
  complete(call: DriverCall): Promise<DriverResult>;
}

/**
 * Collaborators a driver cannot get from declarative config. `signRequest` and
 * `accessToken` belong to the cloud drivers: bedrock needs SigV4 headers,
 * vertex needs an OAuth token — both produced outside this package.
 */
export interface DriverDeps extends HttpDeps {
  secrets: SecretPort;
  bucket: TokenBucket;
  retry: RetryConfig;
  signRequest?: (req: { method: string; url: string; body: string }) => Promise<Record<string, string>>;
  accessToken?: () => Promise<string>;
}
