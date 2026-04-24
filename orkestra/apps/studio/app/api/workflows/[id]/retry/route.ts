import { appendAudit } from "@/lib/audit";
import { authOptions, canWrite } from "@/lib/auth";
import { db } from "@/lib/db";
import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: Request, ctx: Ctx) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!canWrite(session.user.role))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await ctx.params;
  const run = await db.workflowRun.findUnique({ where: { id } });
  if (!run) return NextResponse.json({ error: "not found" }, { status: 404 });

  const backendUrl = process.env.ORKESTRA_WORKER_URL;
  if (backendUrl) {
    try {
      await fetch(`${backendUrl}/workflows/${id}/retry`, { method: "POST" });
    } catch (err) {
      console.warn("retry: worker call failed", err);
    }
  }

  const updated = await db.workflowRun.update({
    where: { id },
    data: { retryCount: run.retryCount + 1, status: "running" },
  });
  await appendAudit({
    actor: session.user.id,
    action: "workflow.retry",
    subject: id,
    workflowRunId: id,
  });
  return NextResponse.json(updated);
}
