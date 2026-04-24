import { appendAudit } from "@/lib/audit";
import { authOptions, canWrite } from "@/lib/auth";
import { db } from "@/lib/db";
import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";

const BodySchema = z.object({
  variantId: z.string().min(1),
  knowledgeFileId: z.string().min(1),
  detach: z.boolean().default(false),
});

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!canWrite(session.user.role))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const parsed = BodySchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const { variantId, knowledgeFileId, detach } = parsed.data;

  if (detach) {
    await db.variantKnowledgeLink.delete({
      where: { variantId_knowledgeFileId: { variantId, knowledgeFileId } },
    });
  } else {
    await db.variantKnowledgeLink.upsert({
      where: { variantId_knowledgeFileId: { variantId, knowledgeFileId } },
      update: {},
      create: { variantId, knowledgeFileId },
    });
  }

  await appendAudit({
    actor: session.user.id,
    action: detach ? "knowledge.detach" : "knowledge.attach",
    subject: knowledgeFileId,
    payload: { variantId },
  });

  return NextResponse.json({ ok: true });
}
