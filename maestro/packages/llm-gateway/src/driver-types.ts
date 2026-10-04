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
   * Overrides the driver's own endpoint for THIS call.
   *
   * Set when the active model came from the panel rather than the environment
   * (`ModelResolver`). It travels per call for the same reason `credentialRef`
   * does: a model an operator retargets in the UI must reach the next request
   * without the port being rebuilt, and a value captured at composition time
   * could never do that. Absent means "use the configured base URL", which is
   * what every deployment that still names its endpoint in `.env` gets.
   *
   * Only the `openai-compat` driver reads it — it is the one transport whose
   * server is an operator's choice rather than a vendor's fixed API root.
   */
  baseUrl?: string;
  /**
   * Overrides the driver's own key reference — a subscription seat carries its
   * own credential while riding the same transport (M55).
   */
  credentialRef?: string;
  /**
   * The panel row's "skip TLS certificate verification" switch, travelling
   * beside `baseUrl` because they are facts of the same row: the address the
   * operator retargets in the UI may sit behind a corporate/self-signed
   * certificate, and the run must perform the same handshake the panel's
   * green test did. Only the `openai-compat` driver reads it, like `baseUrl`.
   */
  skipTlsVerify?: boolean;
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
/**
 * A tool the model may call during an agent session (OpenAI function-calling
 * shape). `parameters` is a JSON Schema object — the driver forwards it as-is.
 */
export interface ChatToolSpec {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

export interface ChatToolCall {
  readonly id: string;
  readonly name: string;
  /** Raw JSON text as the model produced it; the caller parses and validates. */
  readonly arguments: string;
}

export type ChatMessage =
  | { readonly role: "system" | "user"; readonly content: string }
  | { readonly role: "assistant"; readonly content: string | null; readonly toolCalls?: readonly ChatToolCall[] }
  | { readonly role: "tool"; readonly toolCallId: string; readonly content: string };

export interface ChatCall {
  model: string;
  messages: readonly ChatMessage[];
  tools: readonly ChatToolSpec[];
  maxTokens: number;
  temperature: number;
  baseUrl?: string;
  credentialRef?: string;
  skipTlsVerify?: boolean;
  counter?: CallCounter;
}

export interface ChatResult {
  text: string | null;
  toolCalls: readonly ChatToolCall[];
  tokensIn: number;
  tokensOut: number;
  finishReason: string | null;
}

export interface LlmDriver {
  readonly id: ApiDriverId;
  complete(call: DriverCall): Promise<DriverResult>;
  /**
   * Multi-turn, tool-calling completion. Optional: only drivers whose wire
   * protocol carries tool calls implement it, and an agent runner that needs
   * it refuses with a named error when the routed driver lacks it — never a
   * silent fall-back to a plain completion that would "answer" without
   * having read a single file.
   */
  chat?(call: ChatCall): Promise<ChatResult>;
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
