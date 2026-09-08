import { DEFAULT_LOCALE, agentTraining } from "@maestro/config";
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
 * never read again at flow time. Env vermeyen bir kurulumda (banka) o model
 * artık bir bulut adı DEĞİL, `MODEL_NOT_SELECTED` işaret değeridir — aşağıya
 * bakın. The persona is a short, honest default; the
 * real per-role prompt still lives in `packages/agent-roles` and is merged at
 * run time (M38), so this is a starting overlay, not the whole prompt.
 */

/** A default variant's identity and starting version-1 fields. */
export interface DefaultVariant {
  readonly variantId: string;
  /** Studio label ("platform" in the write API) — the agent's display name. */
  readonly platform: string;
  /**
   * The four agents of the customer's chain. `dev_reviewer` IS the verifier:
   * the step-6c role the engine already has, now trained as the customer's
   * "doğrulayıcı" (build + rule-by-rule PASS/FAIL).
   */
  readonly role: "analyst" | "planner" | "engineer" | "dev_reviewer";
  /**
   * The agent's TRAINING — the customer's brief for that agent, shipped as the
   * persona of the default definition so it is visible and editable in Studio
   * ("Ajan tanımları"), not buried in code. The text itself lives in the
   * locale catalogue (`agent.training.*`), which is also the engine's fallback
   * for an agent whose persona was emptied.
   */
  readonly persona: string;
}
export const MODEL_NOT_SELECTED = "secilmedi";

/**
 * Kurulum sırasında version 1'e yazılacak bootstrap model.
 *
 * `PILOT_MODEL` env verilmişse o; verilmemişse — bankada durum bu, compose
 * `PILOT_MODEL` tanımlamıyor — `MODEL_NOT_SELECTED`. Yani kurulum bir model
 * UYDURMAZ; operatörü Studio'daki "Ajan tanımları" ekranından seçmeye zorlar,
 * ve seçilene kadar durum her yerde adıyla okunur.
 *
 * Arg olarak geçilir (burada okunmaz) ki seed saf bir fonksiyon kalsın ve
 * çevrimdışı test onu deterministik sürsün.
 */
export const DEFAULT_VARIANT_MODEL = MODEL_NOT_SELECTED;

/** Bir model adı gerçek bir seçim mi, yoksa "henüz seçilmedi" mi? */
export function isModelSelected(model: string | null | undefined): boolean {
  const trimmed = model?.trim() ?? "";
  return trimmed !== "" && trimmed !== MODEL_NOT_SELECTED;
}

/** The two thinking roles a fresh install ships a variant for. */
export const DEFAULT_VARIANTS: readonly DefaultVariant[] = [
  {
    variantId: "analyst-default",
    platform: "Analiz ajanı (varsayılan)",
    role: "analyst",
    persona: training("analyst"),
  },
  {
    variantId: "planner-default",
    platform: "Plancı ajan (varsayılan)",
    role: "planner",
    persona: training("planner"),
  },
  {
    variantId: "engineer-default",
    platform: "Geliştirici ajan (varsayılan)",
    role: "engineer",
    persona: training("engineer"),
  },
  {
    variantId: "verifier-default",
    platform: "Doğrulayıcı ajan (varsayılan)",
    role: "dev_reviewer",
    persona: training("dev_reviewer"),
  },
];

function training(role: DefaultVariant["role"]): string {
  const text = agentTraining(DEFAULT_LOCALE, role);
  if (text === null) throw new Error(`no shipped training for role ${role}`);
  return text;
}
