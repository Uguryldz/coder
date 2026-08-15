import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { humanBehind } from "@maestro/audit";
import { sessionActor } from "../actor.js";
import { authGuard, requireAnyRole, sessionOf } from "../auth/guard.js";
import type { BindingWrite, ResolvedDeps } from "../deps.js";
import { badRequest, conflict, notFound } from "../errors.js";
import {
  assertBindable,
  assertProjectBindable,
  bucketize,
  DEFAULT_DRY_RUN_SAMPLE,
  MAX_DRY_RUN_SAMPLE,
} from "../onboarding-service.js";
import { assertWritable, FOUR_EYES_GROUP } from "../platform/propose.js";
import { isMasterApprover } from "../platform/master-approver.js";
import { listScmRepos } from "../scm-repos-service.js";
import { listJiraProjects } from "../jira-projects-service.js";
import { listJiraMatchValues } from "../jira-match-values-service.js";
import type { ConnectionStore } from "../connection-store.js";
import type { SecretPort } from "@maestro/ports";
import { pageOf } from "./paging.js";
import { unwired } from "./unwired.js";

/**
 * Self-service onboarding (M93/M102): connecting a Jira project to a repository.
 *
 * Reading the options is open to the roles that could act on them; both writes
 * are admin/tech-lead, and neither of them CONFIGURES anything. The wizard's
 * last step files a proposal for a second human to approve, because a binding
 * decides where an agent will be allowed to push code — the same reason a
 * guarded parameter takes four eyes (M32/M71/M78).
 */
export const ONBOARDING_ROLES = ["admin", "tech-lead"] as const;

/** Where an onboarding proposal waits for its second approver. */
export const ONBOARDING_PROPOSAL_PREFIX = "onboarding.binding";

/**
 * The wizard's draft, validated as a closed shape.
 *
 * Every enum is the screen's own union (`OnboardingDraft` in
 * `screens/onboard/OnboardingSteps.tsx`) and none of them has a default here:
 * the SCREEN picks the safe defaults, and a server that silently supplied its
 * own would file a proposal for settings nobody chose. `.strict()` refuses an
 * unknown field rather than dropping it, so a client sending `mergeMode: auto`
 * under a misspelled key is told, not quietly given a human merge.
 */
const DraftBody = z
  .object({
    jiraProject: z.string().trim().min(1).max(32),
    adoRepo: z.string().trim().min(1).max(128),
    platform: z.string().trim().min(1).max(32),
    triggerMode: z.enum(["opt_in", "automatic"]),
    gateSet: z.enum(["risk_tiered", "always_six"]),
    mergeMode: z.enum(["human", "auto"]),
  })
  .strict();

/** The `?connectionId=` shared by the live SCM-repo and Jira-project listings. */
const ConnectionIdQuery = z.object({ connectionId: z.string().trim().min(1).max(64) });
const MatchValuesQuery = z.object({
  connectionId: z.string().trim().min(1).max(64),
  project: z.string().trim().min(1).max(64),
  kind: z.enum(["status", "issuetype"]),
});

/** Approve/reject an onboarding package by the project it binds. */
const ApproveBody = z.object({ projectKey: z.string().trim().min(1).max(32) }).strict();
const RejectBody = z
  .object({
    projectKey: z.string().trim().min(1).max(32),
    reason: z.string().trim().max(256).optional(),
  })
  .strict();

/**
 * Split a repo's full name (`owner/repo`) into the two registry columns.
 *
 * The wizard sends the exact string it picked from the live SCM list, so the
 * appId is that string verbatim and the two halves are what the SCM/`.docx`
 * adapters read (owner → `adoProject`, repo → `adoRepo`; M100). A name with no
 * slash, or an empty half, is not a repository this platform can bind, so it is
 * refused by name rather than written as a row with a blank column.
 */
function splitRepoFullName(
  fullName: string,
): { adoProject: string; adoRepo: string } | null {
  const slash = fullName.indexOf("/");
  if (slash <= 0 || slash === fullName.length - 1) return null;
  const adoProject = fullName.slice(0, slash);
  const adoRepo = fullName.slice(slash + 1);
  // A second slash would make `adoRepo` itself contain one; GitHub repo names
  // never do, so this is a malformed pick rather than a nested path.
  if (adoRepo.includes("/")) return null;
  return { adoProject, adoRepo };
}

/**
 * The onboarding draft's two-valued choices, mapped to the binding columns.
 *
 * `triggerMode automatic` → `auto` (every ticket starts a run); `opt_in` → `label`
 * (wait for the maestro label / a command, M48a). `mergeMode auto` → `full_auto`;
 * `human` → `human_lead` (a person owns the merge). `dataClass` is NOT in the
 * draft, so it fails closed to `gizli` — the same safe default the intake path
 * applies to an unlabelled binding, because guessing low is the guess that leaks.
 */
function bindingFromProposal(value: OnboardingProposalValue): BindingWrite {
  return {
    projectKey: value.jiraProject,
    trigger: value.triggerMode === "automatic" ? "auto" : "label",
    state: "active",
    defaults: {
      appId: value.appId,
      mode: value.mergeMode === "auto" ? "full_auto" : "human_lead",
      dataClass: "gizli",
    },
  };
}

/** The shape stored in an `onboarding.binding` pending value (submit writes it). */
interface OnboardingProposalValue {
  jiraProject: string;
  adoRepo: string;
  platform: string;
  triggerMode: "opt_in" | "automatic";
  gateSet: "risk_tiered" | "always_six";
  mergeMode: "human" | "auto";
  appId: string;
}

/**
 * The connector store, or 503-by-name when a deployment did not wire it — the
 * SCM-picker endpoints cannot list repos without the connections that hold the
 * credential, and an empty list would read as "no repos" rather than "connectors
 * are not editable here" (the `connections` unwired convention).
 */
function connectorStore(deps: ResolvedDeps): ConnectionStore {
  if (deps.connections === undefined) unwired("connections");
  return deps.connections;
}

function connectorSecrets(deps: ResolvedDeps): SecretPort {
  if (deps.connectorSecrets === undefined) unwired("connections");
  return deps.connectorSecrets;
}

/** The dry run needs only the routing half of the draft; the screen sends exactly that. */
const DryRunBody = z
  .object({
    jiraProject: z.string().trim().min(1).max(32),
    adoRepo: z.string().trim().min(1).max(128),
    sampleSize: z.coerce.number().int().positive().max(MAX_DRY_RUN_SAMPLE).optional(),
  })
  .strict();

/** What the screen renders; `DryRunResult` in `screens/common/onboarding-api.ts`. */
const DryRunResponse = z.object({
  byRule: z.array(z.string()),
  bySuggestion: z.array(z.string()),
  unresolved: z.array(z.string()),
  sampled: z.number().int().nonnegative(),
  projectKey: z.string(),
  appId: z.string(),
});

/** `OnboardingOptions` — three flat string lists, exactly as the selects expect. */
const OptionsResponse = z.object({
  jiraProjects: z.array(z.string()),
  adoRepos: z.array(z.string()),
  platforms: z.array(z.string()),
});

const ProposalResponse = z.object({
  proposalId: z.string(),
  status: z.literal("pending_four_eyes"),
  approverGroup: z.string(),
});

export async function onboardingRoutes(app: FastifyInstance, deps: ResolvedDeps): Promise<void> {
  const preHandler = [authGuard(deps), requireAnyRole(...ONBOARDING_ROLES)];

  /**
   * The lists the wizard's selects are built from (M93).
   *
   * Bound projects are included, carrying nothing but their key here — the
   * conflict is reported by the dry run and the submit path, which can say
   * WHICH state is in the way. Omitting them would make an already-bound
   * project simply missing from the list, with no way for the operator to find
   * out why the project they came to connect is not there.
   */
  app.get("/onboarding/options", { preHandler }, async (request, reply) => {
    const options = await deps.read.onboarding.options(pageOf(request.query));
    const body = OptionsResponse.parse({
      jiraProjects: options.projects.map((project) => project.projectKey),
      adoRepos: options.repos.map((repo) => repo.appId),
      platforms: [...options.platforms],
    });
    return reply.code(200).send(body);
  });

  /**
   * The SCM connections a repo can be picked from (github / ADO). Read straight
   * off the managed connector list (Ayarlar > Bağlantılar) so the wizard offers
   * exactly what the platform is actually wired to — never a hard-coded "ADO".
   * Only the non-secret fields are returned; the token never leaves the store.
   */
  app.get("/onboarding/scm-connections", { preHandler }, async (_request, reply) => {
    const store = connectorStore(deps);
    const all = await store.list();
    const scm = all
      .filter((c) => c.enabled && (c.kind === "github" || c.kind === "ado"))
      .map((c) => ({ id: c.id, kind: c.kind, displayName: c.displayName }));
    return reply.code(200).send({ connections: scm });
  });

  /**
   * The repositories a chosen SCM connection can reach — read LIVE off the
   * provider with the connection's STORED token (the `jira-workflow` pattern: a
   * live read behind an unwired gate). The token is fetched here and passed to
   * the service; it never appears in the request, the response or an error.
   */
  app.get("/onboarding/scm-repos", { preHandler }, async (request, reply) => {
    const store = connectorStore(deps);
    const secrets = connectorSecrets(deps);
    const parsed = ConnectionIdQuery.safeParse(request.query);
    if (!parsed.success) throw badRequest("invalid_onboarding_body");

    const connection = await store.get(parsed.data.connectionId);
    if (connection === null) throw badRequest("unknown_connection");

    const token =
      connection.secretRef === null
        ? null
        : await secrets.get(connection.secretRef).catch(() => null);
    const result = await listScmRepos(connection, token, deps.connectorFetch);
    return reply.code(200).send(result);
  });

  /**
   * The Jira connections a project can be picked from (Cloud / Data Center),
   * read off the managed connector list — the sibling of `scm-connections`. The
   * project list is empty until a project is actually bound (the binding table
   * is what `options` reads), so an operator onboarding the FIRST project has
   * nothing to select; this lets them pick projects LIVE off Jira instead. Only
   * the non-secret fields are returned.
   */
  app.get("/onboarding/jira-connections", { preHandler }, async (_request, reply) => {
    const store = connectorStore(deps);
    const all = await store.list();
    const jira = all
      .filter((c) => c.enabled && (c.kind === "jira_cloud" || c.kind === "jira_dc"))
      // `botAccountId` (learned on connection test) lets a listening rule offer
      // "the bot" instead of a hand-copied GUID. Absent until the connection has
      // been tested once; the rule form falls back to free text then.
      .map((c) => ({
        id: c.id,
        kind: c.kind,
        displayName: c.displayName,
        botAccountId: c.config["botAccountId"] ?? null,
      }));
    return reply.code(200).send({ connections: jira });
  });

  /**
   * The projects a chosen Jira connection can reach — read LIVE off Jira with
   * the connection's STORED token (same pattern as `scm-repos`). The token is
   * fetched here and passed to the service; it never appears in the request, the
   * response or an error.
   */
  app.get("/onboarding/jira-projects", { preHandler }, async (request, reply) => {
    const store = connectorStore(deps);
    const secrets = connectorSecrets(deps);
    const parsed = ConnectionIdQuery.safeParse(request.query);
    if (!parsed.success) throw badRequest("invalid_onboarding_body");

    const connection = await store.get(parsed.data.connectionId);
    if (connection === null) throw badRequest("unknown_connection");

    const token =
      connection.secretRef === null
        ? null
        : await secrets.get(connection.secretRef).catch(() => null);
    const result = await listJiraProjects(connection, token, deps.connectorFetch);
    return reply.code(200).send(result);
  });

  /**
   * The status / issue-type NAMES a listening rule can match on for a project —
   * read live off Jira so the rule form offers a dropdown of exactly the names
   * Jira will present, instead of free text where "hata" vs "Hata" silently
   * matches nothing. Same connection + stored-token pattern as jira-projects.
   */
  app.get("/onboarding/jira-match-values", { preHandler }, async (request, reply) => {
    const store = connectorStore(deps);
    const secrets = connectorSecrets(deps);
    const parsed = MatchValuesQuery.safeParse(request.query);
    if (!parsed.success) throw badRequest("invalid_onboarding_body");

    const connection = await store.get(parsed.data.connectionId);
    if (connection === null) throw badRequest("unknown_connection");

    const token =
      connection.secretRef === null
        ? null
        : await secrets.get(connection.secretRef).catch(() => null);
    const result = await listJiraMatchValues(
      connection,
      parsed.data.project,
      parsed.data.kind,
      token,
      deps.connectorFetch,
    );
    return reply.code(200).send(result);
  });

  /**
   * The dry run (M102): where the last N tickets WOULD land under these rules.
   *
   * It replays REAL runs from the project's history and reads each one's
   * recorded `MatchResult`, so the three buckets are a measurement rather than
   * a preview. A project with no history returns three empty buckets and
   * `sampled: 0` — the screen can then say the run proved nothing, which is
   * true and is not the same sentence as "everything resolved cleanly".
   *
   * Not a write, and deliberately not gated on the kill switch: rehearsing a
   * binding changes nothing, and an operator working out what went wrong during
   * an incident should still be able to ask.
   *
   * It does NOT require the repo to be in the registry. The rehearsal replays a
   * PROJECT's history and is independent of which repo the operator is about to
   * bind — insisting the repo already exist would make the dry run impossible
   * for the repo picked LIVE off SCM, which is the whole point of onboarding a
   * NEW app (the same reason submit registers the repo itself). Only the project
   * is checked, and only for "already bound".
   */
  app.post("/onboarding/dry-run", { preHandler }, async (request, reply) => {
    const parsed = DryRunBody.safeParse(request.body);
    if (!parsed.success) throw badRequest("invalid_onboarding_body");

    await assertProjectBindable(deps, parsed.data.jiraProject);
    const limit = parsed.data.sampleSize ?? DEFAULT_DRY_RUN_SAMPLE;
    const samples = await deps.read.onboarding.recentTickets(parsed.data.jiraProject, limit);
    const buckets = bucketize(samples);

    return reply.code(200).send(
      DryRunResponse.parse({
        ...buckets,
        projectKey: parsed.data.jiraProject,
        // The repo the operator picked — echoed back as the appId. The dry run
        // rehearses the project, so this is the target it rehearsed against, not
        // a registry lookup.
        appId: parsed.data.adoRepo,
      }),
    );
  });

  /**
   * Submit the wizard (M93). Files a PROPOSAL; it never binds anything.
   *
   * The four-eyes channel is `ParamStore.putPending`, the same one a guarded
   * parameter and a kill-switch change wait in (M32/M71/M58) — one queue an
   * admin already watches, rather than a second approval mechanism that could
   * disagree with the first about who has confirmed what.
   *
   * A dry run is a precondition of ACTIVATION, not of proposing: the approver
   * is the one who must have seen it, and this endpoint records the draft for
   * them to judge. What it does enforce is that the target is real and free,
   * because a proposal to bind a project that is already live is not a decision
   * worth putting in front of a human.
   *
   * When an `appRegistry` writer is wired (M100), the repo is first REGISTERED
   * into the inventory — the wizard is what creates the app row, so an operator
   * no longer has to have onboarded the repo through some other path before it
   * can be bound. The binding itself stays four-eyes: registering a repo is
   * inventory, but pointing a project's tickets at it is the decision a second
   * human confirms. Without the writer the endpoint keeps its older behaviour,
   * where `assertBindable` requires the repo to already exist.
   */
  app.post("/onboarding", { preHandler }, async (request, reply) => {
    const parsed = DraftBody.safeParse(request.body);
    if (!parsed.success) throw badRequest("invalid_onboarding_body");

    // Nothing is filed while the platform is stopped (M58). A proposal is not
    // an effect, but it is the first half of one, and an incident is not the
    // moment to queue up new bindings for an approver to find later. The
    // registration below is a write too, so it must not happen either.
    await assertWritable(deps);

    const actor = sessionActor(sessionOf(request));
    const at = deps.clock.now().toISOString();
    const scopeRef = parsed.data.jiraProject;

    // Check the PROJECT before writing anything. Registering the repo and only
    // then finding the project unusable would leave a stranded app row with no
    // proposal — so an unknown or already-bound project is refused here, before
    // the inventory write below can happen.
    await assertProjectBindable(deps, scopeRef);

    // Register the repo into the inventory, when the deployment wired a writer.
    // `assertBindable` then finds the row it just wrote and the older
    // `unknown_app` wall no longer stands between the wizard and a repo the
    // operator legitimately picked off the live SCM list. The binding stays a
    // proposal below — this only fills the inventory, it does not route anything.
    if (deps.appRegistry !== undefined) {
      const halves = splitRepoFullName(parsed.data.adoRepo);
      if (halves === null) throw badRequest("invalid_repo_name", { repo: parsed.data.adoRepo });
      await deps.appRegistry.register({
        appId: parsed.data.adoRepo,
        displayName: parsed.data.adoRepo,
        adoProject: halves.adoProject,
        adoRepo: halves.adoRepo,
        platform: parsed.data.platform,
      });
      // The inventory write is its own audited fact, separate from the binding
      // proposal below: one records that the app now exists, the other that a
      // human proposed pointing a project at it. `AuditAction` (frozen) has no
      // APP_REGISTERED, and PARAM_CHANGED is the closest true statement — the
      // same convention the other registry writes use.
      await deps.audit.append({
        actor,
        action: "PARAM_CHANGED",
        subject: `application:${parsed.data.adoRepo}`,
        at,
        meta: {
          registered: "application",
          appId: parsed.data.adoRepo,
          adoProject: halves.adoProject,
          adoRepo: halves.adoRepo,
          platform: parsed.data.platform,
          createdVia: "onboarding",
        },
      });
    }

    const target = await assertBindable(deps, parsed.data);
    // The selected platform must be the repo's own. A mismatch means the
    // operator changed the repo after step 2 and the wizard carried a stale
    // profile — binding on it would build the app in the wrong toolchain.
    if (parsed.data.platform !== target.platform) {
      throw conflict("platform_mismatch", {
        appId: target.appId,
        platform: target.platform,
      });
    }

    // One open proposal per project. A second one would leave two drafts
    // waiting on the same binding with no rule about which the approver's
    // confirmation applies to.
    const pending = await deps.params.pending();
    const open = pending.find(
      (candidate) =>
        candidate.key === ONBOARDING_PROPOSAL_PREFIX && candidate.scopeRef === scopeRef,
    );
    if (open !== undefined && open.proposedBy !== actor) {
      throw conflict("proposal_open", { projectKey: scopeRef, proposedBy: open.proposedBy });
    }

    await deps.params.putPending({
      key: ONBOARDING_PROPOSAL_PREFIX,
      scopeRef,
      value: { ...parsed.data, appId: target.appId },
      proposedBy: actor,
      at,
    });

    await deps.audit.append({
      actor,
      action: "PARAM_CHANGED",
      subject: `onboarding:${scopeRef}`,
      at,
      meta: {
        proposal: "onboarding_binding",
        projectKey: scopeRef,
        appId: target.appId,
        triggerMode: parsed.data.triggerMode,
        gateSet: parsed.data.gateSet,
        mergeMode: parsed.data.mergeMode,
      },
    });

    return reply.code(202).send(
      ProposalResponse.parse({
        proposalId: `${ONBOARDING_PROPOSAL_PREFIX}:${scopeRef}:${at}`,
        status: "pending_four_eyes",
        approverGroup: FOUR_EYES_GROUP,
      }),
    );
  });

  /**
   * The onboarding packages waiting for a second approver (M93).
   *
   * Reads the SAME pending queue a guarded parameter waits in (`params.pending`),
   * filtered to `onboarding.binding`. Until now this queue had no reader — a
   * submitted package sat in it invisibly and nobody could approve it. This is
   * the list the "Jira bağlantısı & eşleme" screen renders so an admin can act.
   */
  app.get("/onboarding/pending", { preHandler }, async (_request, reply) => {
    const open = (await deps.params.pending()).filter(
      (candidate) => candidate.key === ONBOARDING_PROPOSAL_PREFIX,
    );
    const items = open.map((entry) => {
      const value = entry.value as OnboardingProposalValue;
      return {
        projectKey: entry.scopeRef ?? value.jiraProject,
        appId: value.appId,
        adoRepo: value.adoRepo,
        platform: value.platform,
        triggerMode: value.triggerMode,
        gateSet: value.gateSet,
        mergeMode: value.mergeMode,
        proposedBy: entry.proposedBy,
        at: entry.at,
      };
    });
    return reply.code(200).send({ items });
  });

  /**
   * Approve an onboarding package: turn the proposal into a LIVE binding (M93).
   *
   * Four-eyes: the approver must be a DIFFERENT human from the proposer — the
   * whole point of the queue is that a second person confirms where an agent will
   * be allowed to push code. `assertProjectBindable` is re-checked at approval
   * time, not just at submit: a project bound by someone else in between must not
   * be silently re-pointed (TOCTOU). The binding write is what makes the project
   * live; the proposal is then cleared. `bindingWriter` unwired → 503-by-name.
   */
  app.post("/onboarding/approve", { preHandler }, async (request, reply) => {
    const parsed = ApproveBody.safeParse(request.body);
    if (!parsed.success) throw badRequest("invalid_onboarding_body");
    if (deps.bindingWriter === undefined) unwired("bindingWriter");

    await assertWritable(deps);

    const open = (await deps.params.pending()).find(
      (candidate) =>
        candidate.key === ONBOARDING_PROPOSAL_PREFIX && candidate.scopeRef === parsed.data.projectKey,
    );
    if (open === undefined) throw notFound("no_pending_binding", { projectKey: parsed.data.projectKey });

    const session = sessionOf(request);
    const actor = sessionActor(session);
    // A person cannot approve their own proposal. Compared through `humanBehind`
    // so an AI delegate acting for a person is still that person (M32/M101).
    // EXCEPTION: a master admin (maestro-admins) may approve their own package —
    // a single-admin install must not deadlock. The audit trail records it as a
    // solo approval so the exception is visible, not hidden.
    const selfApproval =
      humanBehind(actor) !== null && humanBehind(actor) === humanBehind(open.proposedBy);
    const masterSolo = selfApproval && isMasterApprover(session.groups);
    if (selfApproval && !masterSolo) {
      throw conflict("self_approval", { projectKey: parsed.data.projectKey });
    }

    // Re-check the project is still free at approval time (TOCTOU).
    await assertProjectBindable(deps, parsed.data.projectKey);

    const value = open.value as OnboardingProposalValue;
    await deps.bindingWriter.bind(bindingFromProposal(value));
    await deps.params.clearPending(ONBOARDING_PROPOSAL_PREFIX, parsed.data.projectKey);

    const at = deps.clock.now().toISOString();
    await deps.audit.append({
      actor,
      action: "PARAM_CHANGED",
      subject: `onboarding:${parsed.data.projectKey}`,
      at,
      meta: {
        approved: "onboarding_binding",
        projectKey: parsed.data.projectKey,
        appId: value.appId,
        approvedBy: actor,
        // True only when a master admin approved a package they proposed
        // themselves — the four-eyes exemption, recorded so it is auditable.
        soloApproval: masterSolo,
      },
    });

    // The chain's next natural step: this project has no listening rules yet.
    return reply
      .code(200)
      .send({ status: "bound", projectKey: parsed.data.projectKey, nextStep: "listening_rule" });
  });

  /**
   * Reject (or withdraw) an onboarding package (M93).
   *
   * Unlike approve, the PROPOSER may reject their own package — withdrawing a
   * draft you filed is legitimate. It only clears the pending entry; no binding
   * is written. The Application row the submit registered stays (it is inventory,
   * not a binding), so a later re-proposal reuses it.
   */
  app.post("/onboarding/reject", { preHandler }, async (request, reply) => {
    const parsed = RejectBody.safeParse(request.body);
    if (!parsed.success) throw badRequest("invalid_onboarding_body");

    const open = (await deps.params.pending()).find(
      (candidate) =>
        candidate.key === ONBOARDING_PROPOSAL_PREFIX && candidate.scopeRef === parsed.data.projectKey,
    );
    if (open === undefined) throw notFound("no_pending_binding", { projectKey: parsed.data.projectKey });

    await deps.params.clearPending(ONBOARDING_PROPOSAL_PREFIX, parsed.data.projectKey);

    const actor = sessionActor(sessionOf(request));
    const at = deps.clock.now().toISOString();
    await deps.audit.append({
      actor,
      action: "PARAM_CHANGED",
      subject: `onboarding:${parsed.data.projectKey}`,
      at,
      meta: {
        rejected: "onboarding_binding",
        projectKey: parsed.data.projectKey,
        rejectedBy: actor,
        ...(parsed.data.reason === undefined ? {} : { reason: parsed.data.reason }),
      },
    });

    return reply.code(200).send({ status: "rejected", projectKey: parsed.data.projectKey });
  });
}
