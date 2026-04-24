import pino from "pino";

const level = process.env.LOG_LEVEL ?? "info";
const isDev = process.env.NODE_ENV !== "production";

/**
 * Root logger. All modules should child() off of this with component name.
 * Correlation ID is attached per request via `logger.child({ correlationId })`.
 */
export const logger = pino({
  level,
  redact: {
    paths: [
      "*.password",
      "*.token",
      "*.apiKey",
      "*.authorization",
      "*.cookie",
      "*.secret",
      "req.headers.authorization",
      "req.headers.cookie",
    ],
    censor: "[REDACTED]",
  },
  ...(isDev
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss.l", ignore: "pid,hostname" },
        },
      }
    : {}),
});

export function createLogger(component: string, extra: Record<string, unknown> = {}) {
  return logger.child({ component, ...extra });
}
