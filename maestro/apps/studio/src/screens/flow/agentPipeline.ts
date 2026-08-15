/**
 * The AGENT pipeline — Maestro's OWN step machine, drawn as a picture.
 *
 * This is the screen Uğur actually wanted: not Jira's status diagram ("hangi
 * statüdeyiz"), but "hangi adımda HANGİ AJAN ne iş yapıyor". The nine steps here
 * mirror `apps/pilot/src/state.ts` STEP_DEFINITIONS exactly — same ids, same
 * order — because the live run reports its progress against those very ids over
 * `/studio/pilot/state` (`steps[].state`). So this model is the labelled MAP and
 * the pilot's `steps[]` is the live POSITION on it; the two share the id space,
 * and nothing about a step's position is invented here.
 *
 * WHY A HAND-WRITTEN MODEL, NOT the frozen contract: `packages/contracts` owns
 * the run status enum and is frozen. WHICH AGENT owns a step and WHAT it does is
 * presentation — an operator's mental model of the team — so it lives here as a
 * new type, never an edit to the frozen schema. The ids are the only coupling,
 * and they are asserted against STEP_DEFINITIONS by the test.
 *
 * BRANCHES ARE REAL. The pilot's flow (apps/pilot/src/run.ts) has two off-ramps
 * the happy path hides: the intake gate can RETURN the ticket to its reporter
 * (İADE) instead of analysing it, and the analysis review gate can REJECT back
 * to re-analysis. Both are drawn as labelled branch edges so the map tells the
 * whole truth, not just the straight line.
 */

/** Who owns a step. Drives the node's colour and the legend. */
export type PipelineActor =
  | "maestro" // Maestro itself (read, PR, merge, audit) — orchestration glue.
  | "agent" // An AI role agent does the work (intake, analysis, code, scan, test).
  | "human"; // A person must act — a Jira /approve gate.

/** A labelled off-ramp from a step, drawn as a branch edge. */
export interface PipelineBranch {
  /** Short edge label ("İADE", "red"). */
  readonly label: string;
  /** Where the branch lands — a human-readable target, shown on hover/title. */
  readonly to: string;
  /** `back` routes to an earlier step (dashed, reversed); `out` leaves the flow. */
  readonly kind: "back" | "out";
}

/** One step of the agent pipeline. `id` matches pilot STEP_DEFINITIONS. */
export interface PipelineStep {
  /** Pilot step id ("1".."9") — the join key to the live `steps[]`. */
  readonly id: string;
  /** Who runs this step. */
  readonly actor: PipelineActor;
  /** The agent/actor's display name ("Intake Ajanı", "Analist Yönetici"). */
  readonly role: string;
  /** Short title of the step ("Uygunluk kapısı"). */
  readonly title: string;
  /** One line: what this actor actually does here. */
  readonly task: string;
  /** Off-ramps from this step (İADE, red). Empty for a straight step. */
  readonly branches: readonly PipelineBranch[];
}

/**
 * The canonical nine steps, in flow order.
 *
 * `id`/order are the contract with the pilot; `role`/`task`/`branches` are the
 * new, human-facing map. Kept deliberately terse — the diagram has little room,
 * and the full sentence already lives in the pilot's `hint`.
 */
export const AGENT_PIPELINE: readonly PipelineStep[] = [
  {
    id: "1",
    actor: "maestro",
    role: "Maestro",
    title: "Talep okundu",
    task: "Atanan ticket'ı canlı Jira'dan çeker, etiketler, durum yorumu açar.",
    branches: [],
  },
  {
    id: "2",
    actor: "agent",
    role: "Intake Ajanı",
    title: "Uygunluk kapısı",
    task: "Ticket analize hazır mı? Değilse netleştirme sorar ve İADE eder.",
    branches: [{ label: "İADE", to: "Talebi açan kişiye geri (Yapılacaklar)", kind: "out" }],
  },
  {
    id: "3",
    actor: "human",
    role: "Analist Yönetici",
    title: "Analiz onayı",
    task: "Üretilen analizi (Word+PDF) inceler; /approve ile onaylar ya da reddeder.",
    branches: [{ label: "red", to: "Adım 2 — yeniden analiz", kind: "back" }],
  },
  {
    id: "4",
    actor: "agent",
    role: "Yazılım Ajanı",
    title: "Kod yazımı",
    task: "İzole sandbox'ta gerçek dosya içeriği üretir (gerekirse düzeltme turları).",
    branches: [],
  },
  {
    id: "5",
    actor: "agent",
    role: "Tarama Ajanı",
    title: "Kişisel veri taraması",
    task: "Üretilen kodu PII sızıntısına karşı tarar (fail-closed).",
    branches: [],
  },
  {
    id: "6",
    actor: "agent",
    role: "Test Ajanı",
    title: "Testler",
    task: "Üretilen test dosyasını gerçekten çalıştırır — sonuç uydurulmaz.",
    branches: [],
  },
  {
    id: "7",
    actor: "maestro",
    role: "Maestro",
    title: "PR + CI",
    task: "Dal + pull request açar; CI (build) sonucunu bekler.",
    branches: [],
  },
  {
    id: "8",
    actor: "human",
    role: "İnceleyen",
    title: "PR onayı",
    task: "Canlı Jira'da ikinci /approve yoklanır — kod birleşmeden önceki insan kapısı.",
    branches: [],
  },
  {
    id: "9",
    actor: "maestro",
    role: "Maestro",
    title: "Merge + denetim",
    task: "PR birleşir; hash-zincirli denetim kaydı doğrulanır.",
    branches: [],
  },
];

/** The three actor buckets, in a fixed order for the legend. */
export const ACTOR_ORDER: readonly PipelineActor[] = ["maestro", "agent", "human"];

/** Catalog key for an actor's legend label. */
export function actorLabelKey(actor: PipelineActor): string {
  return `flow.actor.${actor}`;
}
