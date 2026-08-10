import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sessionActor } from "../actor.js";
import { authGuard, requireAnyRole, sessionOf } from "../auth/guard.js";
import type { ResolvedDeps } from "../deps.js";
import { badRequest, conflict } from "../errors.js";
import {
  assertBindable,
  bucketize,
  DEFAULT_DRY_RUN_SAMPLE,
  MAX_DRY_RUN_SAMPLE,
} from "../onboarding-service.js";
import { assertWritable, FOUR_EYES_GROUP } from "../platform/propose.js";
import { pageOf } from "./paging.js";

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
   */
  app.post("/onboarding/dry-run", { preHandler }, async (request, reply) => {
    const parsed = DryRunBody.safeParse(request.body);
    if (!parsed.success) throw badRequest("invalid_onboarding_body");

    const target = await assertBindable(deps, parsed.data);
    const limit = parsed.data.sampleSize ?? DEFAULT_DRY_RUN_SAMPLE;
    const samples = await deps.read.onboarding.recentTickets(parsed.data.jiraProject, limit);
    const buckets = bucketize(samples);

    return reply.code(200).send(
      DryRunResponse.parse({
        ...buckets,
        projectKey: parsed.data.jiraProject,
        appId: target.appId,
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
   */
  app.post("/onboarding", { preHandler }, async (request, reply) => {
    const parsed = DraftBody.safeParse(request.body);
    if (!parsed.success) throw badRequest("invalid_onboarding_body");

    // Nothing is filed while the platform is stopped (M58). A proposal is not
    // an effect, but it is the first half of one, and an incident is not the
    // moment to queue up new bindings for an approver to find later.
    await assertWritable(deps);

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

    const actor = sessionActor(sessionOf(request));
    const at = deps.clock.now().toISOString();
    const scopeRef = parsed.data.jiraProject;

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
}
