import { type GateDecision, JournalKind, type StepId, type TicketKey } from "@maestro/contracts";
import { planEscalation, type ResolvedStep } from "@maestro/notify";
import type { GateVerdict } from "../activities.js";
import { GATE_OWNER } from "../gates.js";
import type { ActivityDeps } from "./deps.js";
import { handOver } from "./outcome.js";
import { activitySeq, audit, notifyEvent, record } from "./record.js";

/** Milliseconds in one hour — the unit the workflow counts its waiting in. */
const HOUR_MS = 60 * 60 * 1000;

/**
 * The group whose members may self-approve to break a single-admin deadlock
 * (the BFF calls it `FOUR_EYES_GROUP`). Kept as a local literal so the
 * workflows package takes no dependency on the BFF; both must name the same
 * group, and it is the same string the seed plants (`FIRST_ADMIN_GROUP`).
 */
const MASTER_APPROVER_GROUP = "maestro-admins";

/**
 * Which audit action each verdict writes.
 *
 * `return_analysis` gets its OWN action rather than borrowing `GATE_REJECT`,
 * and that is the whole point of it being a third verdict: an auditor counting
 * "how many times was this rejected" must not be handed the ordinary review
 * turns as refusals. See the note on `GATE_RETURN` in `contracts/audit.ts`.
 */
const AUDIT_OF: Readonly<Record<GateDecision["decision"], "GATE_APPROVE" | "GATE_REJECT" | "GATE_RETURN">> = {
  approve: "GATE_APPROVE",
  reject: "GATE_REJECT",
  return_analysis: "GATE_RETURN",
};

/** The verdict as the ticket's own journal line says it, in the operator's words. */
const VERDICT_WORD: Readonly<Record<GateDecision["decision"], string>> = {
  approve: "onay",
  reject: "ret",
  return_analysis: "analize geri gönderildi",
};

/**
 * Is this user a master admin? A live directory lookup (hence an activity):
 * true when they are a member of {@link MASTER_APPROVER_GROUP}. Used only to
 * waive the cross-gate four-eyes rule for a single master admin.
 */
export async function isMasterApprover(deps: ActivityDeps, userId: string): Promise<boolean> {
  const members = await deps.directory.membersOf(MASTER_APPROVER_GROUP);
  return members.includes(userId);
}

/**
 * The human gates (M51/M88) and the two cross-cutting activities every step
 * uses. Nothing here ever decides anything: reminders escalate, they do not
 * approve, and a gate closes only when a person's decision arrives.
 */

/** Step 4/5/9/11/12 opening: the record, the trail, the ticket, the audience. */
export async function openGate(
  deps: ActivityDeps,
  ticket: TicketKey,
  step: StepId,
  ownerGroup: string,
  gateStatuses?: { approve?: string; return?: string },
): Promise<string> {
  const run = await deps.runs.get(ticket);
  const at = deps.now().toISOString();
  // The workflow passes a ROLE; the gate record must carry the group that
  // exists in the directory, because that is what `verifyMembership` is asked
  // about later. See `DirectoryReader.groupForRole` for what happened when the
  // two were allowed to differ.
  const group = await deps.directory.groupForRole(ownerGroup);
  // Idempotent: a retry re-reads the existing record, so `openedAt` — the
  // anchor the whole escalation ladder is measured from — never moves.
  await deps.gates.open(run.runId, step, group, at);
  /**
   * KOŞUNUN SATIRI DA KAPIDA BEKLEDİĞİNİ SÖYLEMELİ.
   *
   * `state.status = "gate"` yalnızca workflow'un BELLEĞİNDE duruyordu
   * (`gate-loop.ts`), ve `journal()` satıra yalnız `step`'i yazıyor
   * (bkz. aşağıdaki `stepOfTitle`). `WorkflowRun.status`'u yazan tek yer
   * `delivery.ts`'in kapanıştaki `done`'ıydı — yani kapıda bekleyen her koşu
   * veritabanında `running` kalıyordu. Dev'de 13 koşunun 11'i böyleydi.
   *
   * Neden önemli: panel motora sorabildiği sürece doğru cevabı alıyor, ama
   * Temporal geçmişi retention'da düştüğünde (ya da motor cevap veremediğinde)
   * geriye yalnız satır kalıyor ve satır "çalışıyor" diyor. Bekleyen bir insan
   * onayı, kimsenin bakması gerekmeyen işlerin arasına gömülüyor.
   *
   * Neden BURADA, `awaitGate` içinde değil: `awaitGate` workflow tarafında ve
   * orada `deps` yok — satır yazmak bir activity işi. `openGate` zaten kapı
   * açılırken tam bir kez çalışan activity, ve idempotent (`gates.open` ve
   * `once` ile). Buraya koymak workflow'un komut dizisini de değiştirmiyor,
   * yani replay güvenli.
   *
   * `reconciledState` (bff/routes/studio-runs.ts) BOZULMUYOR: o yalnızca satır
   * TERMİNAL olduğunda motorun cevabını eziyor. `gate` terminal değil, dolayısıyla
   * canlı motor cevabı üstün kalmaya devam ediyor. `reconcile.ts` de `gate`'i
   * `RECONCILE_PROTECTED` sayıyor — yani bu satırı hiçbir uzlaştırma turu
   * `running`'e geri düşürmez. İki taraf da bu değeri BEKLİYORDU; yazan yoktu.
   */
  await deps.runs.patch(ticket, { status: "gate" });
  await audit(deps, run, { action: "GATE_OPEN", meta: { step, ownerGroup: group }, key: `open:${step}` });
  await record(deps, run, {
    kind: "gate",
    title: `kapı ${step} açıldı`,
    detail: group,
    key: `open:${step}`,
  });
  /**
   * KAPI YORUMU — VE NEDEN İKİ SÜRÜMÜ VAR.
   *
   * Eski metin şunu diyordu ve DOĞRUYDU: "ticket'ı başka bir statüye taşımak
   * kapıyı açmaz." Artık kuralın kapı statüleri doluysa AÇIYOR, ve o cümle
   * yanlış bir talimata dönüştü — yanlış talimat, hiç talimat olmamasından
   * kötüdür, çünkü operatör onu okuyup denemekten vazgeçer.
   *
   * İki anahtar, tek bir "koşullu cümle" değil: hangi statülerin işlediği bu
   * koşuya özgü ve mesaj kataloğu (M104) parametreleri interpole ediyor, bir
   * cümleyi şartlı olarak yutamıyor. Statü kanalı yapılandırılmamış kurulumda
   * eski metin AYNEN geçerli ve aynen yazılıyor.
   */
  const approveStatus = gateStatuses?.approve?.trim() ?? "";
  const returnStatus = gateStatuses?.return?.trim() ?? "";
  const comment =
    approveStatus === "" && returnStatus === ""
      ? deps.translate(run.locale, "jira.gate_open", { gate: step, group })
      : deps.translate(run.locale, "jira.gate_open_with_status", {
          gate: step,
          group,
          // Yapılandırılmamış tarafın yerine "—" değil, o tarafın olmadığını
          // SÖYLEYEN bir ifade: boş bir tırnak, operatörün "buraya bir statü
          // yazmam mı gerekiyordu" diye düşünmesine yol açar.
          approve: approveStatus === "" ? deps.translate(run.locale, "jira.gate_status_none") : approveStatus,
          returnTo: returnStatus === "" ? deps.translate(run.locale, "jira.gate_status_none") : returnStatus,
        });
  await deps.idempotency.once(`${run.runId}:gate-comment:${step}`, () =>
    deps.work.addComment(ticket, comment),
  );
  await notifyEvent(deps, run, {
    event: "gate_open",
    messageKey: "notify.gate_open",
    params: { ticket, gate: step, group },
    to: await deps.directory.membersOf(group),
    key: `open:${step}`,
  });
  // Returned so the WORKFLOW knows the group it opened against. `canCloseGate`
  // runs inside the workflow and cannot call the directory itself; without this
  // it compared the claim to the ROLE and refused every real approval as
  // `wrong_group` — the OPS-34 failure, one layer above `recordGateDecision`.
  return group;
}

/**
 * A decision is on the record only after its author's group membership has been
 * checked against the directory (M32/M51).
 *
 * The workflow already refused everything `canCloseGate` could see, but that
 * function only compares the group the SIGNAL claims. A decision that reaches
 * here claiming a membership the directory does not know is a forgery, not a
 * mistake — but it is the CLAIM that is wrong, not the run. The verdict goes
 * back to the workflow, which leaves the gate open and tells the person why;
 * failing the activity would kill a healthy run over somebody else's typo.
 */
export async function recordGateDecision(
  deps: ActivityDeps,
  ticket: TicketKey,
  decision: GateDecision,
): Promise<GateVerdict> {
  const run = await deps.runs.get(ticket);
  const role = GATE_OWNER[decision.step as keyof typeof GATE_OWNER];
  // Resolved through the directory for the same reason `openGate` resolves it:
  // the claim on the signal names the group the BFF verified against, and that
  // is a directory group, not a role.
  const expected = role === undefined ? undefined : await deps.directory.groupForRole(role);
  /**
   * ÜYELİĞİN İKİNCİ ÖLÇÜMÜ — ama ölçülecek bir grup varsa.
   *
   * `unconfigured`, BFF'in "bu kurulumda eşlenmiş bir dizin grubu YOK" demesi
   * (bkz. `GateDecision.membershipCheck`). Burada yine sorsaydık olmayan bir
   * gruba yeniden üyelik sorar, aynı 404'ü yer ve BFF'in bilerek geçirdiği
   * kararı reddederdik — yani düzeltme tam olarak düzeltmeye çalıştığı yerde
   * çalışmazdı.
   *
   * Bir bypass DEĞİL: bayrak sinyalin içinde taşınıyor ve `GateDecision`
   * şemasından geçiyor; onu üretebilen tek yer `decideGate` ve orası bayrağı
   * yalnız dizin eşlemesi gerçekten yokken yazıyor. Kararın kimliği
   * (`actorUserId`), denetim zinciri (`signatureSeq`) ve grup karşılaştırması
   * (`expected`) her iki dalda da aynen uygulanıyor.
   */
  const member =
    decision.membershipCheck === "unconfigured"
      ? true
      : await deps.work.verifyMembership(decision.actorUserId, decision.actorGroup);
  if (!member || (expected !== undefined && decision.actorGroup !== expected)) {
    await record(deps, run, {
      kind: "gate",
      title: "üyelik doğrulanamadı",
      detail: `${decision.actorUserId} · ${decision.actorGroup}`,
      key: `deny:${decision.step}:${decision.signatureSeq}`,
    });
    return {
      accepted: false,
      reason: `${decision.actorUserId} · "${decision.actorGroup}" üyeliği doğrulanamadı`,
    };
  }

  await audit(deps, run, {
    action: AUDIT_OF[decision.decision],
    // M32/M101: an approval is only ever recorded against a human actor.
    actor: decision.actorUserId,
    meta: { step: decision.step, signatureSeq: decision.signatureSeq, reason: decision.reason ?? null },
    key: `decision:${decision.step}:${decision.signatureSeq}`,
  });
  await deps.gates.close(run.runId, decision.step, decision.at);
  /**
   * `openGate`'in yazdığı `gate` durumunun KARŞILIĞI: kapı kapandı, koşu yine
   * çalışıyor. Bu satır olmasaydı `openGate`'in düzeltmesi kendi hatasını
   * üretirdi — onaylanmış ve devam eden bir koşu sonsuza dek "onay bekliyor"
   * görünürdü, ki bu düzeltmeye çalıştığımız yanlışın aynadaki hâli.
   *
   * `gate` terminal olmadığı için `runs.get` bu koşuyu bulmaya devam ediyor
   * (bkz. `run-context.ts`'teki `TERMINAL_STATUSES`), yani buraya kadar
   * gelebiliyoruz. Yazım kabul edilen karardan SONRA: reddedilen bir karar
   * (üyelik doğrulanamadı) kapıyı açık bırakır, dolayısıyla durum da `gate`
   * kalmalı.
   */
  await deps.runs.patch(ticket, { status: "running" });
  await record(deps, run, {
    kind: "gate",
    actor: "human",
    title: `kapı ${decision.step}: ${VERDICT_WORD[decision.decision]}`,
    detail: decision.reason ?? "",
    key: `decision:${decision.step}:${decision.signatureSeq}`,
  });
  return { accepted: true };
}

/**
 * One reminder tick (M88). The workflow says how long it has been waiting; the
 * ladder — which lives entirely in the `escalation.ladder` parameter (M71) —
 * says what that means.
 *
 * `now` is derived from the gate's own anchor plus the workflow's count, NOT
 * from the activity's wall clock: the workflow is the only clock that survives
 * a replay, and a reminder that fired on wall-clock time would fire again on
 * every retry.
 */
export async function escalateGate(
  deps: ActivityDeps,
  ticket: TicketKey,
  step: StepId,
  waitingHours: number,
): Promise<string | null> {
  const run = await deps.runs.get(ticket);
  const gate = await deps.gates.get(run.runId, step);
  if (gate === null || gate.closedAt !== null) return null;

  const ladder = await deps.params.escalationLadder(run.runId);
  const now = new Date(Date.parse(gate.openedAt) + waitingHours * HOUR_MS).toISOString();
  const owners = await deps.directory.membersOf(gate.ownerGroup);
  const deputies = await deps.directory.membersOf(`${gate.ownerGroup}-deputy`);

  const plan = planEscalation(ladder, {
    openedAt: gate.openedAt,
    now,
    firedStepIds: gate.firedStepIds,
    locale: run.locale,
    params: { ticket, gate: step, group: gate.ownerGroup, hours: String(waitingHours) },
    recipients: (ladderStep: ResolvedStep) => (ladderStep.action === "delegate" ? deputies : owners),
  });

  for (const notification of plan.notifications) {
    await deps.idempotency.once(
      `${run.runId}:escalate:${step}:${notification.messageKey}:${notification.at}:${notification.channel}`,
      () => deps.notify.send(notification),
    );
  }
  if (plan.due.length > 0) {
    await deps.gates.markFired(run.runId, step, plan.due.map((s) => s.stepId));
    await record(deps, run, {
      kind: "gate",
      title: `kapı ${step} hatırlatıcı`,
      detail: plan.due.map((s) => s.stepId).join(", "),
      key: `escalate:${step}:${plan.due.map((s) => s.stepId).join("-")}`,
    });
  }
  // Nobody to remind. This used to be fatal — `planEscalation` threw, the
  // activity exhausted its retries, and the WORKFLOW died over an empty
  // approver group, taking a gate that was correctly waiting for a human with
  // it. Now it is written down instead, in the two places a human looks: the
  // ticket journal, and the ticket itself. An unreminded gate still waits; an
  // unreminded gate NOBODY KNOWS ABOUT waits forever.
  if (plan.unaddressed.length > 0) {
    const detail = `${gate.ownerGroup}: ${plan.unaddressed.map((s) => s.stepId).join(", ")}`;
    await record(deps, run, {
      kind: "gate",
      title: `kapı ${step} hatırlatıcısı gönderilemedi — grupta kimse yok`,
      detail,
      key: `unaddressed:${step}:${plan.unaddressed.map((s) => s.stepId).join("-")}`,
    });
    // On the ticket too: the journal is where the platform remembers, but Jira
    // is where the humans are (M61), and this is precisely the case where no
    // human was told anything by any other route.
    await deps.idempotency.once(`${run.runId}:gate-unaddressed:${step}`, () =>
      deps.work.addComment(
        ticket,
        deps.translate(run.locale, "jira.gate_unaddressed", {
          gate: step,
          group: gate.ownerGroup,
        }),
      ),
    );
  }
  // A delegation moves the gate to the deputy; it never closes it (M88).
  for (const delegation of plan.delegations) {
    await record(deps, run, {
      kind: "gate",
      title: `kapı ${step} vekile devredildi`,
      detail: delegation.stepId,
      key: `delegate:${step}:${delegation.stepId}`,
    });
  }
  return plan.next?.dueAt ?? null;
}

/**
 * The ledger entry every step transition writes (M30). Gate and handover
 * entries are also posted to the ticket: Jira is where the humans are (M61),
 * and "your decision was refused because…" is useless inside a database.
 */
export async function journal(
  deps: ActivityDeps,
  ticket: TicketKey,
  kind: string,
  title: string,
  detail: string,
): Promise<void> {
  const run = await deps.runs.get(ticket);
  const parsed = JournalKind.safeParse(kind);
  const resolved = parsed.success ? parsed.data : "other";
  // Temporal's own attempt number is the discriminator, and it is exactly the
  // right one: a RETRY of this activity repeats the attempt and is collapsed,
  // while a second lap of the M54 loop is a new activity with a new sequence
  // and writes its own line. A purely content-derived key made "adım 6a" on
  // round three indistinguishable from round one, so the ledger lost the laps.
  const seq = activitySeq();
  await record(deps, run, {
    kind: resolved,
    title,
    detail,
    key: `flow:${seq}:${resolved}:${title}:${detail}`,
  });
  if (resolved === "gate" || resolved === "handover") {
    await deps.idempotency.once(`${run.runId}:comment:${seq}:${resolved}:${title}:${detail}`, () =>
      deps.work.addComment(ticket, `${title}${detail === "" ? "" : ` — ${detail}`}`),
    );
  }

  /**
   * Carry the step onto the run's ROW, not just into workflow state.
   *
   * `goto` advances `state.step` inside the execution, and Studio reads
   * `WorkflowRun.step` from Postgres — so every screen showed step 0 for a run
   * that had reached the analysis gate. The two have to agree: an operator
   * looking at the ticket list is looking at this column.
   *
   * Derived from the title `goto` writes rather than taken as an argument,
   * because `journal` is the activity every transition already goes through
   * and adding a parameter would mean every OTHER caller had to say "no step",
   * which is a thing to forget.
   */
  const step = stepOfTitle(title);
  if (step !== null) await deps.runs.patch(ticket, { step });
}

/** `adım 6a` → `6a`. Anything else is a journal line about something else. */
function stepOfTitle(title: string): string | null {
  const match = /^adım\s+([0-9]+[a-zö]?)$/u.exec(title.trim());
  return match?.[1] ?? null;
}

export async function handOverToHuman(
  deps: ActivityDeps,
  ticket: TicketKey,
  reason: string,
): Promise<void> {
  const run = await deps.runs.get(ticket);
  await handOver(deps, run, reason, `flow:${reason}`);
  deps.execution.endRun(run.runId);
}
