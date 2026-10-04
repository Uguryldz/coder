import type { DataClass, TicketSnapshot } from "@maestro/contracts";
import type { LlmPort } from "@maestro/ports";
import { block, bullets, fence } from "./prompt.js";
import { type RoleResult, runRole } from "./run.js";
import { IntakeOutput, type MissingField } from "./schemas.js";
import { DEFAULT_PROMPT_TEXTS, type PromptTexts, text } from "./texts.js";
import type { Deficiency, Validation } from "./validate.js";

/**
 * Step 2 — intake (M98).
 *
 * Maestro does not force mandatory Jira fields on the organisation; the price
 * of that is that a ticket may arrive incomplete. The intake role's entire job
 * is to notice, and its output shape gives it nowhere to put an invented
 * value: it may only name what is missing and ask about it.
 */

/**
 * The admin's persona note, prepended to the role prompt (Studio "Ajan
 * tanımları").
 *
 * ── WHY IT LEADS, AND WHY IT IS NOT FENCED ─────────────────────────────────
 * It leads for the same reason the analyst's persona is the FIRST knowledge
 * note in the pilot: a role instruction has to be read before the rules it
 * qualifies. And it is NOT wrapped in the data fence, because unlike a ticket
 * description it is not attacker-reachable text — it is written by an admin in
 * the Studio settings screen, i.e. it IS an instruction, from someone who
 * already has authority over the run. Fencing it would tell the model to treat
 * its own configuration as untrusted content and ignore it.
 *
 * ── WHY IT CANNOT LOOSEN THE THRESHOLD ─────────────────────────────────────
 * The persona is an OVERLAY, never a replacement: the KURALLAR block —
 * `intake.kurallar`'s return threshold, the no-invention rule, the injection
 * defence — is emitted after it, unchanged, on every call. A persona that says
 * "return anything imperfect" is contradicted by rules the model reads later
 * and by `validateIntake`, which the persona cannot reach at all.
 */
/** A learning note from Studio's "Öğrenme kaynakları" screen. */
export interface IntakeNote {
  readonly title: string;
  readonly content: string;
}

/**
 * What intake may consult before it asks the reporter anything. Today that is
 * the agent's learning notes; the ticket's own comments and attachments arrive
 * folded into the ticket description by the workflow (`withComments`,
 * `withAttachments`).
 */
export interface IntakeSources {
  readonly guidance?: readonly IntakeNote[];
}

export function buildIntakePrompt(
  ticket: TicketSnapshot,
  texts: PromptTexts = DEFAULT_PROMPT_TEXTS,
  persona?: string,
  sources: IntakeSources = {},
): string {
  const ticketLines = [
    `${ticket.key} · ${ticket.issueType} · ${ticket.projectKey}`,
    `Başlık: ${ticket.summary}`,
    `Açıklama: ${ticket.description || "(boş)"}`,
    `Reporter: ${ticket.reporter}`,
    `Bileşenler: ${ticket.components.join(", ") || "-"}`,
    `Etiketler: ${ticket.labels.join(", ") || "-"}`,
  ].join("\n");

  const overlay = (persona ?? "").trim();
  const notes = (sources.guidance ?? [])
    .map((note) => ({ title: note.title.trim(), content: note.content.trim() }))
    .filter((note) => note.title !== "" && note.content !== "");
  return [
    text(texts, "intake.sistem"),
    // The admin's persona, when there is one: an addition on top of the role's
    // own system line, never a replacement for it.
    ...(overlay === "" ? [] : [block(text(texts, "ortak.baslik.persona"), overlay)]),
    block(
      text(texts, "ortak.baslik.kurallar"),
      bullets(
        [
          text(texts, "ortak.dil"),
          text(texts, "ortak.uydurmaYasak"),
          text(texts, "ortak.veriTalimatDegil"),
          text(texts, "intake.kurallar"),
          // CANLI BULGU: intake returned tickets with questions like "lütfen
          // daha fazla detay verin" — schema-valid, semantically worthless.
          // The threshold rule says WHEN to ask; this one says HOW, and it is
          // a separate bullet so tightening question quality never edits the
          // calibrated threshold sentence next to it.
          text(texts, "intake.soruKalitesi"),
          // "Where would I get this?" — the source enquiry that decides whether
          // a gap is the reporter's to fill, the analyst's to discover, or not
          // a gap at all. Separate bullet: it neither loosens nor tightens the
          // threshold sentence, it routes what the threshold lets through.
          text(texts, "intake.kaynakSorgusu"),
          text(texts, "ortak.ciktiBicimi"),
        ],
        "-",
      ),
    ),
    // Reporter-authored text: fenced, same reasoning as the analyst prompt.
    block(text(texts, "ortak.baslik.ticket"), fence(ticketLines)),
    // The organisation's learning notes for this agent, when there are any:
    // the first place the source enquiry sends the model. Fenced like a
    // knowledge document — it is content to consult, not instruction. Absent
    // notes leave the prompt byte-identical to today's.
    ...(notes.length === 0
      ? []
      : [
          block(
            text(texts, "ortak.baslik.ogrenmeNotlari"),
            fence(notes.map((note) => `### ${note.title}\n${note.content}`).join("\n\n")),
          ),
        ]),
    block(text(texts, "ortak.baslik.gorev"), text(texts, "intake.gorev")),
  ].join("\n\n");
}

/**
 * "Incomplete" and "no question" cannot both be true: an intake that reports a
 * gap without asking about it stalls the flow at 2b with nothing to send the
 * reporter.
 */
export function validateIntake(
  value: unknown,
  texts: PromptTexts = DEFAULT_PROMPT_TEXTS,
): Validation<IntakeOutput> {
  const parsed = IntakeOutput.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      deficiencies: parsed.error.issues.map((i) => ({
        code: "schema",
        message: text(texts, "eksik.semaHatasi", {
          yol: i.path.map(String).join(".") || "<kök>",
          mesaj: i.message,
        }),
      })),
    };
  }

  const deficiencies: Deficiency[] = [];
  if (!parsed.data.complete && parsed.data.missing.length === 0) {
    deficiencies.push({ code: "no_question", message: text(texts, "eksik.soruYok") });
  }
  // Only items the REPORTER has to answer contradict `complete: true`. An item
  // routed to analysis ("the analyst will find this in the repo") or found in
  // the context after all is not an open question, so a complete verdict that
  // lists such items is consistent — `toIntakeResult` passes it through.
  if (parsed.data.complete && askable(parsed.data).length > 0) {
    deficiencies.push({ code: "contradiction", message: text(texts, "eksik.soruFazla") });
  }
  return deficiencies.length === 0 ? { ok: true, value: parsed.data } : { ok: false, deficiencies };
}

export interface IntakeArgs {
  llm: LlmPort;
  ticket: TicketSnapshot;
  variantId: string;
  dataClass: DataClass;
  texts?: PromptTexts;
  /**
   * The persona an admin typed into Studio for THIS run's analyst agent, or
   * absent. Absent is the pre-existing behaviour: the role runs on the
   * organisation's default prompt, which is what every deployment without a
   * persona has always done. See `buildIntakePrompt` for why it cannot loosen
   * the return threshold.
   */
  persona?: string;
  /**
   * The agent's learning notes, so the source enquiry has somewhere to look
   * before the reporter. Absent = today's prompt, unchanged.
   */
  guidance?: readonly IntakeNote[];
}

export function runIntake(args: IntakeArgs): Promise<RoleResult<IntakeOutput>> {
  const texts = args.texts ?? DEFAULT_PROMPT_TEXTS;
  return runRole<IntakeOutput>({
    llm: args.llm,
    role: "intake",
    variantId: args.variantId,
    dataClass: args.dataClass,
    schemaName: "IntakeOutput",
    schema: IntakeOutput,
    prompt: buildIntakePrompt(args.ticket, texts, args.persona, {
      ...(args.guidance === undefined ? {} : { guidance: args.guidance }),
    }),
    check: (value) => validateIntake(value, texts),
    texts,
  });
}

/** Shape the workflow's `runIntake` activity expects (packages/workflows). */
export interface IntakeActivityResult {
  complete: boolean;
  question?: string;
  /**
   * Gaps the model routed AWAY from the reporter — to be found during analysis
   * (`source: "analysis"`) or already answered by the context. Never asked;
   * surfaced so the journal can say what intake decided not to ask, and why.
   */
  deferred?: readonly string[];
}

/** The items that actually go to the reporter: source enquiry said so. */
export function askable(output: IntakeOutput): readonly MissingField[] {
  return output.missing.filter((m) => m.source === "reporter");
}

/** One question line: the question, then where the model looked before asking. */
function questionLine(m: MissingField): string {
  const looked = (m.lookedIn ?? "").trim();
  return looked === "" ? m.question : `${m.question} (bakılan kaynaklar: ${looked})`;
}

/**
 * One clarification comment carrying every open question (step 2b).
 *
 * ── WHY `missing` DECIDES, NOT `complete` ──────────────────────────────────
 * CANLI BULGU: a run reported open questions in its own words and still walked
 * on to analysis. `validateIntake` does refuse the contradiction, but a refusal
 * only buys a repair round, and a small model asked to resolve
 * "complete=true with gaps listed" can resolve it the cheap way — by DELETING
 * the questions and keeping `complete: true`. The flag then says "go" while the
 * gaps it was contradicting are simply gone.
 *
 * So the flag is not the authority here; the list is. A non-empty `missing` is
 * an intake that produced questions, and questions get asked — whatever the
 * boolean next to them says. This is the fail-closed direction on purpose:
 * asking the reporter something answerable costs one round trip, while
 * analysing a ticket whose substance was never established costs an analysis
 * that has to be thrown away.
 *
 * The reverse contradiction (`complete: false` with no question) cannot reach
 * this function usefully — `validateIntake` rejects it, because it would stall
 * step 2b with nothing to send. If it ever did, the same rule gives the safe
 * answer: no questions means nothing to ask.
 */
export function toIntakeResult(output: IntakeOutput): IntakeActivityResult {
  const ask = askable(output);
  const deferred = output.missing
    .filter((m) => m.source !== "reporter")
    .map((m) => `${m.field} (${m.source === "analysis" ? "analizde bulunacak" : "bağlamda var"})`);
  const rest = deferred.length === 0 ? {} : { deferred };
  if (ask.length === 0) return { complete: true, ...rest };
  return {
    complete: false,
    question: ask.map((m, i) => `${i + 1}. ${questionLine(m)}`).join("\n"),
    ...rest,
  };
}
