import { appendAudit } from "@/lib/audit";
import { authOptions, canWrite } from "@/lib/auth";
import { db } from "@/lib/db";
import { knowledgeHashFromFiles } from "@/lib/knowledge-hash";
import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";

const BodySchema = z.object({
  variantId: z.string().min(1),
  systemPrompt: z.string().min(1),
  model: z.string().min(1),
  temperature: z.number().min(0).max(2).default(0.2),
  maxTokens: z.number().int().positive().max(128_000).default(4096),
  notes: z.string().optional(),
  setActive: z.boolean().default(true),
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
  const { variantId, systemPrompt, model, temperature, maxTokens, notes, setActive } = parsed.data;

  const variant = await db.agentVariant.findUnique({ where: { id: variantId } });
  if (!variant) return NextResponse.json({ error: "variant not found" }, { status: 404 });

  const links = await db.variantKnowledgeLink.findMany({
    where: { variantId },
    include: { knowledgeFile: true },
  });
  const knowledgeHash = knowledgeHashFromFiles(
    links.map((l) => ({
      id: l.knowledgeFileId,
      contentHash: l.knowledgeFile.contentHash,
      version: l.knowledgeFile.version,
    })),
  );

  const latest = await db.promptVersion.findFirst({
    where: { variantId },
    orderBy: { version: "desc" },
  });
  const nextVersion = (latest?.version ?? 0) + 1;

  const pv = await db.promptVersion.create({
    data: {
      variantId,
      version: nextVersion,
      systemPrompt,
      model,
      temperature,
      maxTokens,
      knowledgeHash,
      createdBy: session.user.id,
      notes,
    },
  });

  if (setActive) {
    await db.agentVariant.update({
      where: { id: variantId },
      data: { activeVersionId: pv.id },
    });
  }

  await appendAudit({
    actor: session.user.id,
    action: "prompt_version.publish",
    subject: pv.id,
    payload: { variantId, version: nextVersion, setActive },
  });

  return NextResponse.json(pv);
}
