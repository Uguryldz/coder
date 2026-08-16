/**
 * The Jira status map — the optional "this rule also MOVES the ticket" half of
 * a listening rule, shared by the two surfaces that can write one.
 *
 * It lived inside `Listening.tsx` while that screen was the only way to reach
 * it. The setup wizard (`screens/setup/`) now writes the same map for a
 * first-time operator, and the one thing that must never diverge between the
 * two is the rule about what "no map" looks like on the wire: `null`, never
 * `{}` and never a map with empty strings in it. Two copies of that rule is two
 * chances for one of them to start sending `""` and 400 the whole rule, so the
 * shape, the point list and the builder live here and both screens import them.
 */

/**
 * Mirrors `StatusMapSchema` in the BFF's listening-store. Every point is
 * optional on purpose: an empty field means "bu adımda ticket'ı oynatma", so an
 * operator can move the ticket at two points and leave the other three to the
 * comment-only default.
 */
export interface StatusMap {
  readonly onStart?: string;
  readonly onNeedInfo?: string;
  readonly onReview?: string;
  readonly onRejected?: string;
  readonly onDone?: string;
  readonly reassignOnNeedInfo?: boolean;
}

/**
 * The five status points, in the order the flow actually walks them. Rendering
 * from this list rather than five hand-written blocks is what keeps the form,
 * the round-trip and the table cell from drifting apart when a sixth point is
 * added on the server.
 */
export const STATUS_POINTS = ["onStart", "onNeedInfo", "onReview", "onRejected", "onDone"] as const;
export type StatusPoint = (typeof STATUS_POINTS)[number];

/** A form's own view of the map: every point a string, "" meaning unset. */
export type StatusDraft = Readonly<Record<StatusPoint, string>>;

export const EMPTY_STATUS_DRAFT: StatusDraft = {
  onStart: "",
  onNeedInfo: "",
  onReview: "",
  onRejected: "",
  onDone: "",
};

/**
 * Turn a form's five text fields into the wire shape — or into `null`.
 *
 * `null` is not a stylistic choice: it is the ONE representation of
 * "comment-only mode" the BFF and the store agree on. Sending `{}` would be a
 * second, differently-shaped way to say the same thing, and a rule that had a
 * map and then had every field cleared has to end up indistinguishable from a
 * rule that never had one — otherwise an operator who emptied the form would
 * look at the table and still see a rule that claims to move tickets. (The BFF
 * normalises `{}` to null as well; we send null anyway so the request says
 * plainly what it means rather than relying on the far side to clean up.)
 *
 * Empty fields are OMITTED rather than sent as "": `StatusMapSchema` requires
 * a non-empty string, so an empty one is a 400 for the whole rule instead of
 * the intended "bu adımda ticket'ı oynatma".
 */
export function buildStatusMap(
  enabled: boolean,
  draft: StatusDraft,
  reassignOnNeedInfo: boolean,
): StatusMap | null {
  if (!enabled) return null;
  const map: Record<string, string | boolean> = {};
  for (const point of STATUS_POINTS) {
    const value = draft[point].trim();
    if (value !== "") map[point] = value;
  }
  // `reassignOnNeedInfo` alone is a real configuration: hand the ticket back to
  // its reporter without moving it on the board. It counts as a filled map.
  if (reassignOnNeedInfo) map.reassignOnNeedInfo = true;
  return Object.keys(map).length === 0 ? null : (map as StatusMap);
}

/**
 * The one-glance answer to "does this rule move tickets?".
 *
 * Deliberately compact — the flow order, arrows between the statuses that are
 * actually set, nothing for the points left blank. A rule with no map returns
 * an empty list so the caller can say "yorum" outright rather than leaving a
 * blank that could read as "not loaded yet".
 */
export function statusSummary(map: StatusMap | null | undefined): readonly string[] {
  if (!map) return [];
  return STATUS_POINTS.map((point) => map[point]).filter(
    (value): value is string => typeof value === "string" && value !== "",
  );
}
