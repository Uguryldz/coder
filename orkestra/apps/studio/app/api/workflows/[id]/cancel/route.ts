import { appendAudit } from "@/lib/audit";
import { authOptions, canWrite } from "@/lib/auth";
import { db } from "@/lib/db";
import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!canWrite(session.user.role))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { reason?: string };

  const run = await db.workflowRun.findUnique({ where: { id } });
  if (!run) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Best-effort backend signal. The worker reconciles status from Temporal.
  const backendUrl = process.env.ORKESTRA_WORKER_URL;
  if (backendUrl) {
    try {
      await fetch(`${backendUrl}/workflows/${id}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: body.reason }),
      });
    } catch (err) {
      // Log but do not block the DB write; operators can retry.
      console.warn("cancel: worker call failed", err);
    }
  }

  const updated = await db.workflowRun.update({
    where: { id },
    data: {
      status: "cancelled",
      cancelledAt: new Date(),
      cancellationReason: body.reason ?? "manual cancel from studio",
    },
  });

  await appendAudit({
    actor: session.user.id,
    action: "workflow.cancel",
    subject: id,
    workflowRunId: id,
    payload: { reason: body.reason },
  });

  return NextResponse.json(updated);
}
