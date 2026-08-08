import { z } from "zod";
import { AdoConfigError } from "./errors.js";

/**
 * Dual-mode configuration (M11): one driver, two deployments.
 *
 *  - `server`   → Azure DevOps Server 2022 / TFS on premises:
 *                 https://<host>[/tfs]/<Collection>/<Project>/_apis/...
 *  - `services` → Azure DevOps Services (cloud):
 *                 https://dev.azure.com/<org>/<Project>/_apis/...
 *
 * The collection only exists on premises, which is why the two shapes are a
 * discriminated union instead of one loose object with optional fields.
 */
export const AdoMode = z.enum(["server", "services"]);
export type AdoMode = z.infer<typeof AdoMode>;

/**
 * api-version is pinned PER MODE, never guessed at call time: Server 2022
 * does not serve the 7.x surface, and Services drops unversioned requests.
 * Unpinned api-versions are how integrations silently rot across upgrades.
 */
export const ADO_API_VERSIONS: Record<AdoMode, string> = {
  server: "6.0",
  services: "7.1",
};

const NonEmpty = z.string().trim().min(1);

/** A single api-version override, e.g. "7.0" or "7.1-preview.1". */
const ApiVersion = z.string().regex(/^\d+\.\d+(-preview(\.\d+)?)?$/);

const ServerConfig = z.object({
  mode: z.literal("server"),
  /** Server root, with or without a virtual directory: https://tfs.bank.local/tfs */
  baseUrl: z.url(),
  /** On-prem collection; may itself be a multi-segment path. */
  collection: NonEmpty,
  /** Key handed to the SecretPort — the adapter never holds a raw PAT (M80). */
  tokenRef: NonEmpty,
  apiVersion: ApiVersion.optional(),
});

const ServicesConfig = z.object({
  mode: z.literal("services"),
  org: NonEmpty,
  baseUrl: z.url().default("https://dev.azure.com"),
  tokenRef: NonEmpty,
  apiVersion: ApiVersion.optional(),
});

export const AdoConfig = z.discriminatedUnion("mode", [ServerConfig, ServicesConfig]);
export type AdoConfig = z.infer<typeof AdoConfig>;

/** Parses driver config, turning Zod issues into one typed error (fail-closed). */
export function parseAdoConfig(input: unknown): AdoConfig {
  const parsed = AdoConfig.safeParse(input);
  if (!parsed.success) {
    throw new AdoConfigError(
      parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    );
  }
  return parsed.data;
}

/** The api-version this config sends, honouring an explicit override. */
export function apiVersionFor(config: AdoConfig): string {
  return config.apiVersion ?? ADO_API_VERSIONS[config.mode];
}

function encodePath(segment: string): string {
  // A collection may be a multi-segment path ("tfs/DefaultCollection"); each
  // segment is encoded separately so the separators survive.
  return segment
    .split("/")
    .filter((s) => s.length > 0)
    .map(encodeURIComponent)
    .join("/");
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Project-scoped `_apis` root for the configured mode.
 * Server: <baseUrl>/<collection>/<project>/_apis
 * Services: <baseUrl>/<org>/<project>/_apis
 */
export function apiRoot(config: AdoConfig, project: string): string {
  const owner = config.mode === "server" ? config.collection : config.org;
  return `${trimTrailingSlash(config.baseUrl)}/${encodePath(owner)}/${encodePath(project)}/_apis`;
}
