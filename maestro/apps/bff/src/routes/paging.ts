import { z } from "zod";
import type { SessionRecord } from "../deps.js";
import { badRequest } from "../errors.js";
import type { Page, PageRequest } from "../read-models.js";
import { CROSS_PROJECT_ROLES, projectGroupFor } from "./access.js";

/**
 * Every list endpoint is bounded (M7). A caller may ask for fewer than
 * {@link MAX_PAGE_SIZE} rows and continue with the cursor the previous page
 * returned; a caller may not ask for "all of them", because the journal and the
 * audit trail grow without limit and the one honest answer to an unbounded
 * request is a smaller page plus a cursor.
 */
export const MAX_PAGE_SIZE = 200;
export const DEFAULT_PAGE_SIZE = 50;

export const PageQuery = z.object({
  limit: z.coerce.number().int().positive().max(MAX_PAGE_SIZE).optional(),
  /**
   * Opaque to the caller: the shape is the store's business, and a cursor a
   * client can construct is a cursor a client can use to page past a filter.
   */
  cursor: z.string().trim().min(1).max(512).optional(),
});

export type PageQuery = z.infer<typeof PageQuery>;

/** Parse the shared `limit`/`cursor` pair, refusing anything out of range. */
export function pageOf(query: unknown): PageRequest {
  const parsed = PageQuery.safeParse(query);
  if (!parsed.success) throw badRequest("invalid_page");
  return {
    limit: parsed.data.limit ?? DEFAULT_PAGE_SIZE,
    cursor: parsed.data.cursor ?? null,
  };
}

/**
 * The wire shape of a page. `nextCursor: null` means "this was the last page",
 * which Studio needs to be able to tell from "ask again" without guessing from
 * a short page — a full final page is not a signal.
 */
export function pageBody<T>(page: Page<T>): { items: readonly T[]; nextCursor: string | null } {
  return { items: page.items, nextCursor: page.nextCursor };
}

/**
 * Which projects a session may see, or `null` for "all of them" (M86: an admin
 * and a tech lead carry gates across teams). Returning `null` rather than every
 * project key keeps the store from having to be told a list it would ignore.
 *
 * Group membership is the source (M8) and the naming convention is the seam:
 * `maestro-ugurpay` → `UGURPAY`. A group that is not a project group yields
 * nothing, so a stray directory group can never widen access.
 */
export function visibleProjects(session: SessionRecord): readonly string[] | null {
  if (CROSS_PROJECT_ROLES.some((role) => session.roles.includes(role))) return null;
  const prefix = projectGroupFor("");
  return session.groups
    .filter((group) => group.startsWith(prefix) && group.length > prefix.length)
    .map((group) => group.slice(prefix.length).toUpperCase());
}
