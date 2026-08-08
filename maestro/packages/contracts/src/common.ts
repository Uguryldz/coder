import { z } from "zod";

/** Non-empty trimmed string — the default for any human-facing text field. */
export const NonEmpty = z.string().trim().min(1);

/** Jira issue key, e.g. UGURPAY-123 (Jira DC — M46). */
export const TicketKey = z.string().regex(/^[A-Z][A-Z0-9]+-\d+$/);
export type TicketKey = z.infer<typeof TicketKey>;

/** Jira project key, e.g. UGURPAY. */
export const ProjectKey = z.string().regex(/^[A-Z][A-Z0-9]+$/);
export type ProjectKey = z.infer<typeof ProjectKey>;

/** Application id in the Application Registry (M100). */
export const AppId = z.string().regex(/^[a-z][a-z0-9-]{1,63}$/);
export type AppId = z.infer<typeof AppId>;

/**
 * Temporal workflow run id. Charset is constrained because the id becomes a
 * SINGLE path segment in storage keys (evidence/<year>/<ticket>/<runId>/…):
 * a slash inside it writes a key that can never be parsed back.
 */
export const RunId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{7,}$/);
export type RunId = z.infer<typeof RunId>;

export const IsoDateTime = z.iso.datetime({ offset: true });
export type IsoDateTime = z.infer<typeof IsoDateTime>;

export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
export type Sha256Hex = z.infer<typeof Sha256Hex>;

export const GitSha = z.string().regex(/^[0-9a-f]{7,40}$/);
export type GitSha = z.infer<typeof GitSha>;

/** Data classification; drives LLM routing policy (M18). */
export const DataClass = z.enum(["acik", "dahili", "gizli"]);
export type DataClass = z.infer<typeof DataClass>;

/** Risk tier; decided by analysis, PO may raise but never lower (M51). */
export const RiskTier = z.enum(["dusuk", "orta", "kritik"]);
export type RiskTier = z.infer<typeof RiskTier>;

/** Work modes (M46). */
export const WorkMode = z.enum(["full_auto", "ai_assist", "human_lead", "human_only"]);
export type WorkMode = z.infer<typeof WorkMode>;

/** Runner platform profiles (K60). */
export const PlatformProfile = z.enum([
  "linux-node",
  "linux-android",
  "macos-xcode",
  "windows-dotnet",
]);
export type PlatformProfile = z.infer<typeof PlatformProfile>;

/**
 * Supported locales (M104). Adding a locale = adding a catalog file in
 * packages/config/locales; this enum is the only code touchpoint.
 */
export const Locale = z.enum(["tr", "en"]);
export type Locale = z.infer<typeof Locale>;
