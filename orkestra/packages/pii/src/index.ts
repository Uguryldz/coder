import crypto from "node:crypto";

export type FieldStrategy = "hash" | "redact" | "partial" | "keep";

export interface FieldRule {
  field: string;
  strategy: FieldStrategy;
}

export interface PatternRule {
  name: string;
  regex: string;
  replacement: string;
}

export interface PIIConfig {
  enabled: boolean;
  fieldRules: FieldRule[];
  patternRules: PatternRule[];
}

/**
 * Reverse map stored per-workflow so we can substitute originals back into
 * outputs that quote masked inputs.
 */
export class ReverseMap {
  private map = new Map<string, string>();
  put(masked: string, original: string) {
    this.map.set(masked, original);
  }
  get(masked: string): string | undefined {
    return this.map.get(masked);
  }
  applyReverse(text: string): string {
    let out = text;
    for (const [masked, original] of this.map.entries()) {
      out = out.split(masked).join(original);
    }
    return out;
  }
  size(): number {
    return this.map.size;
  }
}

function hashValue(v: string, salt = "orkestra"): string {
  const h = crypto.createHash("sha256");
  h.update(salt);
  h.update(v);
  return h.digest("hex").slice(0, 8);
}

function applyField(strategy: FieldStrategy, value: string): string {
  switch (strategy) {
    case "hash":
      if (value.includes("@")) {
        const [local, domain] = value.split("@");
        return `usr_${hashValue(local)}@${domain}`;
      }
      return `[HASH:${hashValue(value)}]`;
    case "redact":
      return "[REDACTED]";
    case "partial":
      if (value.length <= 4) return "***";
      return value.slice(0, value.length - Math.min(6, Math.floor(value.length / 2))) + "***";
    case "keep":
    default:
      return value;
  }
}

export function maskText(text: string, config: PIIConfig, reverseMap?: ReverseMap): string {
  if (!config.enabled) return text;
  let out = text;
  for (const r of config.patternRules) {
    try {
      const re = new RegExp(r.regex, "g");
      out = out.replace(re, (m) => {
        const token = `${r.replacement}_${hashValue(m).slice(0, 4)}`;
        reverseMap?.put(token, m);
        return token;
      });
    } catch {
      // invalid regex, skip
    }
  }
  return out;
}

/**
 * Walk any object and apply field rules and pattern rules recursively.
 */
export function maskObject<T>(obj: T, config: PIIConfig, reverseMap?: ReverseMap): T {
  if (!config.enabled) return obj;
  if (obj == null) return obj;
  if (Array.isArray(obj)) {
    return obj.map((x) => maskObject(x, config, reverseMap)) as unknown as T;
  }
  if (typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      const rule = config.fieldRules.find((r) => r.field === k);
      if (rule && typeof v === "string") {
        const masked = applyField(rule.strategy, v);
        reverseMap?.put(masked, v);
        result[k] = masked;
      } else if (typeof v === "string") {
        result[k] = maskText(v, config, reverseMap);
      } else {
        result[k] = maskObject(v, config, reverseMap);
      }
    }
    return result as T;
  }
  if (typeof obj === "string") {
    return maskText(obj, config, reverseMap) as unknown as T;
  }
  return obj;
}
