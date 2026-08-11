/**
 * The agent variants a fresh install starts with (M38).
 *
 * A clean database has NO variant rows, so `GET /variants` renders an empty
 * catalogue and the pilot has no DB record to resolve its analyst/engineer
 * model from — it would fall back to env forever. Seeding one variant per
 * thinking role gives a fresh install working agents an admin can then edit
 * from the UI (a new version with a different model or persona), which is the
 * whole point of the variant designer.
 *
 * The MODEL is a bootstrap default only: `seedDefaultVariants` reads the
 * bootstrap `PILOT_MODEL` env and plants it as version 1's model, and from then
 * on the DB is authoritative — the admin re-versions it from Studio and env is
 * never read again at flow time. The persona is a short, honest default; the
 * real per-role prompt still lives in `packages/agent-roles` and is merged at
 * run time (M38), so this is a starting overlay, not the whole prompt.
 */

/** A default variant's identity and starting version-1 fields. */
export interface DefaultVariant {
  /** Lower-case dash-separated id, the `VarChar(64)` the table stores. */
  readonly variantId: string;
  /** The thinking role this variant configures (`LlmRoleE`). */
  readonly role: "analyst" | "engineer";
  /** The platform overlay (`Variant.name`). `default` = the institution-wide one. */
  readonly platform: string;
  /** A short starting persona overlay; the full prompt lives in agent-roles. */
  readonly persona: string;
}

/**
 * The bootstrap model, read from `PILOT_MODEL` with a sane default.
 *
 * `anthropic/claude-sonnet-4.5` rather than the pilot prop's cheap
 * `openai/gpt-4o-mini`: a fresh BANK install should start on a capable default
 * an admin can downgrade, not the throwaway the local pilot demo uses. Passed
 * in as an arg (not read here) so the seed stays a pure function the offline
 * test drives deterministically.
 */
export const DEFAULT_VARIANT_MODEL = "anthropic/claude-sonnet-4.5";

/** The two thinking roles a fresh install ships a variant for. */
export const DEFAULT_VARIANTS: readonly DefaultVariant[] = [
  {
    variantId: "analyst-default",
    role: "analyst",
    platform: "default",
    persona:
      "Sen kurumun analiz ajanısın. Jira talebini, kurum şablonu ve bilgi " +
      "tabanındaki uyum kurallarıyla birlikte, eksiksiz ve doğrulanabilir bir " +
      "analiz belgesine dönüştürürsün. Emin olmadığın yeri uydurmazsın; açıkça " +
      "'netleştirme gerekli' dersin.",
  },
  {
    variantId: "engineer-default",
    role: "engineer",
    platform: "default",
    persona:
      "Sen kurumun mühendislik ajanısın. Onaylı analizi, repo politikasına ve " +
      "korumalı yollara saygı göstererek, doğrulama koşan küçük ve gözden " +
      "geçirilebilir değişikliklere çevirirsin. Testi geçmeyen bir değişikliği " +
      "asla teslim etmezsin.",
  },
];
