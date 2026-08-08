import { NonEmpty, NotifyChannel } from "@maestro/contracts";
import { z } from "zod";
import { NotifyConfigError } from "./errors.js";

/**
 * Declarative driver config (M44): it holds REFERENCES to secrets
 * (`SecretPort` keys), never secret values. Everything here is a Studio
 * parameter living in the DB (M71) — nothing is compiled in.
 */

/** Port + driver ids for the registry. Driver id == NotifyChannel value. */
export const NOTIFY_PORT = "notify";
export const TEAMS_DRIVER = "teams";
export const SMTP_DRIVER = "smtp";
export const JIRA_DRIVER = "jira";
export const SLACK_DRIVER = "slack";
/** Composite: dispatches by `notification.channel` (M71 channel selection). */
export const MULTI_DRIVER = "multi";

/**
 * Bounded retry (delivery guarantee). Small on purpose: Temporal owns durable
 * retrying; this only absorbs a blip. A permanent failure never retries.
 */
export const RetryPolicy = z.object({
  maxAttempts: z.number().int().min(1).max(10).default(3),
  baseDelayMs: z.number().int().min(0).max(60_000).default(500),
  maxDelayMs: z.number().int().min(0).max(300_000).default(10_000),
});
export type RetryPolicy = z.infer<typeof RetryPolicy>;

/**
 * Incoming-webhook drivers (Teams, Slack). `targets` maps a channel NAME
 * (what Studio shows and what `Notification.to` carries — e.g. "ops",
 * "platform-leads") to a SecretPort key holding the webhook URL. The URL is a
 * bearer credential in its path, so it never appears in config, logs or errors.
 */
export const WebhookDriverConfig = z.object({
  targets: z.record(NonEmpty, NonEmpty),
  requestTimeoutMs: z.number().int().positive().max(120_000).default(15_000),
  retry: RetryPolicy.prefault({}),
});
export type WebhookDriverConfig = z.infer<typeof WebhookDriverConfig>;

/** RFC-5321-ish address check; the CR/LF ban blocks header injection. */
export const EmailAddress = z
  .string()
  .trim()
  .regex(/^[^\s@<>,;:"()[\]\\]+@[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$/);

export const SmtpSecurity = z.enum(["starttls", "implicit", "plaintext"]);
export type SmtpSecurity = z.infer<typeof SmtpSecurity>;

export const SmtpDriverConfig = z.object({
  host: NonEmpty,
  port: z.number().int().min(1).max(65_535).default(587),
  /** starttls = upgrade in place and REQUIRE it; implicit = TLS from byte 0. */
  security: SmtpSecurity.default("starttls"),
  from: EmailAddress,
  fromName: NonEmpty.optional(),
  /** Omit both to send unauthenticated (typical for an internal relay). */
  username: NonEmpty.optional(),
  passwordRef: NonEmpty.optional(),
  ehloName: NonEmpty.default("maestro"),
  /** Escape hatch for a lab relay; NEVER default-on — see smtp-client.ts. */
  allowInsecureAuth: z.boolean().default(false),
  requestTimeoutMs: z.number().int().positive().max(120_000).default(20_000),
  retry: RetryPolicy.prefault({}),
});
export type SmtpDriverConfig = z.infer<typeof SmtpDriverConfig>;

/**
 * Jira comment driver. It owns no Jira client: M44 clean room — the WorkPort
 * driver (`@maestro/adapter-jira`) is injected by the composition root, so
 * this package neither imports it nor knows a Jira URL or PAT exists.
 */
export const JiraDriverConfig = z.object({
  retry: RetryPolicy.prefault({}),
});
export type JiraDriverConfig = z.infer<typeof JiraDriverConfig>;

/**
 * Event → channel routing (M45/M71/M87): which channels an event fans out to.
 * `default` covers every event without an explicit entry; an event mapped to
 * an empty list is muted DELIBERATELY (an explicit decision, not a silent
 * drop) and `routeNotification` reports it as such.
 */
export const NotifyRouting = z.object({
  default: z.array(NotifyChannel).default(["teams"]),
  byEvent: z.record(z.string(), z.array(NotifyChannel)).default({}),
});
export type NotifyRouting = z.infer<typeof NotifyRouting>;

export function parseConfig<T>(schema: z.ZodType<T>, input: unknown, driver: string): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const issues = result.error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  throw new NotifyConfigError(`${driver}: ${issues}`);
}
