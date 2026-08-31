import type { MaestroActivities } from "../activities.js";
import * as analysis from "./analysis.js";
import type { ActivityDeps } from "./deps.js";
import * as delivery from "./delivery.js";
import * as engineering from "./engineering.js";
import * as gate from "./gate.js";
import * as intake from "./intake.js";
import * as scan from "./scan.js";
import * as statusMove from "./status-move.js";

export * from "./deps.js";
export { InMemoryIdempotency } from "./idempotency.js";
export {
  AUTH_RETRY_MAX_ATTEMPTS,
  LLM_AUTH_REJECTED,
  LLM_BLOCKED,
  QUOTA_WAIT,
  guardModelCall,
  guardedLlm,
  handOver,
  outcomeOfRole,
  quotaWait,
  resolveOutcome,
} from "./outcome.js";
export { AI_ASSIST_REQUIRED } from "./analysis.js";
export {
  DOC_TARGETS,
  MIN_DOC_BYTES,
  assertRealDocument,
  deliverAnalysisDocs,
  docFileName,
  type AnalysisDocFile,
  type AnalysisDocsResult,
  type DocTarget,
} from "./analysis-docs.js";
export { scannerErrorResult } from "./scan.js";
/**
 * Studio'daki "Persona" alanını akışa taşıyan yardımcılar.
 *
 * Artık BAĞLI: `analystPersona` intake'in (`intake.ts` — `runIntake`,
 * `matchApplication`) ve analizin (`analysis.ts` — `writeAnalysis`) prompt
 * kurduğu üç yerde çağrılıyor. `engineerPersona`/`withPersona` hazır duruyor
 * ama mühendislik turunda HENÜZ çağrılmıyor: o tur bir prompt kurmuyor, bir
 * `BootstrapContext` kuruyor (`@maestro/execution`), ve o sözleşmede personanın
 * konabileceği bir alan yok — bkz. `engineering.ts`'teki `turnContext`.
 */
export {
  PERSONA_NOTE_TITLE,
  analystPersona,
  engineerPersona,
  withPersona,
  type PersonaWarn,
} from "./persona.js";
/**
 * Ticket'ın insan yorumlarını intake bağlamına taşıyan yardımcılar. Sürücüden
 * okuma `CommentReader` seam'i üzerinden (bkz. `deps.ts`).
 */
export {
  COMMENT_BLOCK_TITLE,
  MAX_COMMENTS,
  MAX_COMMENT_TEXT,
  commentAuthorId,
  commentText,
  humanCommentsOf,
  readHumanComments,
  withComments,
  type HumanComment,
} from "./comments.js";
export { MIN_SUGGESTION_CONFIDENCE, WAITING_LABEL, pickRule, ruleApplies } from "./intake.js";

/**
 * The activity set, bound to one set of collaborators.
 *
 * Every implementation takes `deps` as its first argument and is otherwise a
 * free function, so each one is callable from a test without building a class
 * — and the binding below is the only place that knows the interface's shape,
 * so `MaestroActivities` gaining a method breaks compilation here.
 */
export function createActivities(deps: ActivityDeps): MaestroActivities {
  return {
    resolveWorkMode: (ticket) => intake.resolveWorkMode(deps, ticket),
    matchApplication: (ticket) => intake.matchApplication(deps, ticket),
    runIntake: (ticket) => intake.runIntake(deps, ticket),
    askClarification: (ticket, question) => intake.askClarification(deps, ticket, question),

    discoverRepo: (ticket, appId) => analysis.discoverRepo(deps, ticket, appId),
    writeAnalysis: (ticket, appId) => analysis.writeAnalysis(deps, ticket, appId),
    publishAnalysis: (ticket, doc) => analysis.publishAnalysis(deps, ticket, doc),
    fanOutChildren: (ticket, doc) => analysis.fanOutChildren(deps, ticket, doc),

    openGate: (ticket, step, ownerGroup, gateStatuses) =>
      gate.openGate(deps, ticket, step, ownerGroup, gateStatuses),
    recordGateDecision: (ticket, decision) => gate.recordGateDecision(deps, ticket, decision),
    isMasterApprover: (userId) => gate.isMasterApprover(deps, userId),
    escalateGate: (ticket, step, waitingHours) => gate.escalateGate(deps, ticket, step, waitingHours),

    runEngineering: (ticket, resumeToken, task, attempt) =>
      engineering.runEngineering(deps, ticket, resumeToken, task, attempt),
    runScans: (ticket, attempt) => scan.runScans(deps, ticket, attempt),
    reviewDiff: (ticket, attempt) => engineering.reviewDiff(deps, ticket, attempt),
    designTests: (ticket, attempt) => engineering.designTests(deps, ticket, attempt),
    reviewTests: (ticket, attempt) => engineering.reviewTests(deps, ticket, attempt),
    runTests: (ticket, attempt) => engineering.runTests(deps, ticket, attempt),

    openPullRequest: (ticket) => delivery.openPullRequest(deps, ticket),
    activatePullRequest: (ticket, pr) => delivery.activatePullRequest(deps, ticket, pr),
    verifyCiOrigin: (ticket, signal) => delivery.verifyCiOrigin(deps, ticket, signal),
    mergePullRequest: (ticket, pr) => delivery.mergePullRequest(deps, ticket, pr),
    buildEvidencePackage: (ticket) => delivery.buildEvidencePackage(deps, ticket),
    deliverAnalysis: (ticket, doc) => delivery.deliverAnalysis(deps, ticket, doc),
    closeTicket: (ticket) => delivery.closeTicket(deps, ticket),

    moveTicketStatus: (ticket, move) => statusMove.moveTicketStatus(deps, ticket, move),
    journal: (ticket, kind, title, detail) => gate.journal(deps, ticket, kind, title, detail),
    handOverToHuman: (ticket, reason) => gate.handOverToHuman(deps, ticket, reason),
  };
}
