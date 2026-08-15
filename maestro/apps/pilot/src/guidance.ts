/**
 * The pilot's ANALYSIS GUIDANCE — the enabled "öğren" notes, mirrored from the
 * DB over the BFF proxy (same pattern as listening rules). The analyst reads
 * these when preparing a NEW analysis, so an operator's uploaded knowledge is
 * taken into account ("yeni analiz hazırlarken dikkat edilecekler").
 *
 * The pilot is DB-free, so this in-memory store IS the pilot's copy; the BFF
 * pushes the full enabled set whenever it changes. A note is `{ title, content }`
 * — exactly the `NamedDoc` shape the agent-roles KnowledgePack expects.
 */
export interface GuidanceNote {
  title: string;
  content: string;
}

export class GuidanceStore {
  private notes: readonly GuidanceNote[] = [];

  constructor(initial: readonly GuidanceNote[] = []) {
    this.set(initial);
  }

  /** Replace the whole set (the BFF mirror sends the full enabled list). */
  set(notes: readonly GuidanceNote[]): void {
    this.notes = notes
      .filter((n): n is GuidanceNote =>
        typeof n?.title === "string" && n.title.trim().length > 0 &&
        typeof n?.content === "string" && n.content.trim().length > 0,
      )
      .map((n) => ({ title: n.title.trim(), content: n.content.trim() }));
  }

  snapshot(): readonly GuidanceNote[] {
    return this.notes;
  }
}
