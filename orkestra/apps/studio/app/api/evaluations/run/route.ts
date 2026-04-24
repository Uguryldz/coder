import { appendAudit } from "@/lib/audit";
import { authOptions, canWrite } from "@/lib/auth";
import { db } from "@/lib/db";
import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";

const BodySchema = z.object({
  variantId: z.string().min(1),
  fromVersionId: z.string().min(1),
  toVersionId: z.string().min(1),
  goldenTicketIds: z.array(z.string()).min(1),
  notes: z.string().optional(),
});

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!canWrite(session.user.role))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const parsed = BodySchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid body", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const evaluation = await db.evaluation.create({
    data: {
      variantId: parsed.data.variantId,
      fromVersionId: parsed.data.fromVersionId,
      toVersionId: parsed.data.toVersionId,
      createdBy: session.user.id,
      notes: parsed.data.notes,
    },
  });

  // Best-effort: delegate heavy lifting to the worker. The worker fills in
  // EvaluationRun rows with MinIO refs and final scores.
  const backendUrl = process.env.ORKESTRA_WORKER_URL;
  if (backendUrl) {
    try {
      await fetch(`${backendUrl}/evaluations/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          evaluationId: evaluation.id,
          goldenTicketIds: parsed.data.goldenTicketIds,
        }),
      });
    } catch (err) {
      console.warn("evaluation: worker call failed", err);
    }
  }

  await appendAudit({
    actor: session.user.id,
    action: "evaluation.run",
    subject: evaluation.id,
    payload: {
      variantId: parsed.data.variantId,
      fromVersionId: parsed.data.fromVersionId,
      toVersionId: parsed.data.toVersionId,
      goldenTicketIds: parsed.data.goldenTicketIds,
    },
  });

  return NextResponse.json(evaluation);
}
