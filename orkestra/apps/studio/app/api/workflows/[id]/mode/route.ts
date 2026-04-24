import { appendAudit } from "@/lib/audit";
import { authOptions, canWrite } from "@/lib/auth";
import { db } from "@/lib/db";
import { WorkMode } from "@orkestra/contracts";
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
  const body = await req.json();
  const parsed = WorkMode.safeParse(body?.workMode);
  if (!parsed.success) return NextResponse.json({ error: "invalid mode" }, { status: 400 });

  const updated = await db.workflowRun.update({
    where: { id },
    data: { workMode: parsed.data },
  });
  await appendAudit({
    actor: session.user.id,
    action: "workflow.mode_change",
    subject: id,
    workflowRunId: id,
    payload: { workMode: parsed.data },
  });
  return NextResponse.json(updated);
}
