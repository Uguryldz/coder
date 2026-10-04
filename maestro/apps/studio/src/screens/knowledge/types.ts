/** A guidance note as `/studio/guidance` returns it. */
export interface GuidanceNote {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly enabled: boolean;
  readonly updatedAt: string;
  /** Target agent; null/absent = every agent's analysis sees it. */
  readonly variantId?: string | null;
}

/** Who may add/toggle/delete guidance notes — the BFF's gate, mirrored. */
export const GUIDANCE_WRITE_ROLES = ["admin", "tech-lead"] as const;

/** The shared query key: a write on either screen refreshes both. */
export const GUIDANCE_QUERY_KEY = ["guidance"] as const;

/** A note's target as a string: "" = every agent. */
export function targetOf(note: GuidanceNote): string {
  return typeof note.variantId === "string" ? note.variantId.trim() : "";
}

/** The first `max` characters of a note, for a table cell. */
export function excerpt(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
