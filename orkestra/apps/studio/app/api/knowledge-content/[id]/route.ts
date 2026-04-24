import { appendAudit } from "@/lib/audit";
import { authOptions, canWrite } from "@/lib/auth";
import { db } from "@/lib/db";
import { contentHash } from "@/lib/knowledge-hash";
import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

const contentKeyFor = (id: string) => `kf-content:${id}`;

const BodySchema = z.object({
  content: z.string(),
});

export async function GET(_req: Request, ctx: Ctx) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const file = await db.knowledgeFile.findUnique({ where: { id } });
  if (!file) return NextResponse.json({ error: "not found" }, { status: 404 });
  const setting = await db.setting.findUnique({ where: { key: contentKeyFor(id) } });
  const raw = setting?.value as unknown;
  const content =
    typeof raw === "string"
      ? raw
      : raw && typeof raw === "object" && "content" in (raw as Record<string, unknown>)
        ? String((raw as { content: unknown }).content ?? "")
        : "";
  return NextResponse.json({ id, content, file });
}

export async function PUT(req: Request, ctx: Ctx) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!canWrite(session.user.role))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await ctx.params;
  const parsed = BodySchema.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const file = await db.knowledgeFile.findUnique({ where: { id } });
  if (!file) return NextResponse.json({ error: "not found" }, { status: 404 });

  const hash = contentHash(parsed.data.content);
  const sizeBytes = Buffer.byteLength(parsed.data.content, "utf8");

  await db.setting.upsert({
    where: { key: contentKeyFor(id) },
    update: {
      value: { content: parsed.data.content } as never,
      updatedBy: session.user.id,
    },
    create: {
      key: contentKeyFor(id),
      value: { content: parsed.data.content } as never,
      updatedBy: session.user.id,
    },
  });

  const nextVersion = file.contentHash === hash ? file.version : file.version + 1;
  const updated = await db.knowledgeFile.update({
    where: { id },
    data: {
      contentHash: hash,
      sizeBytes,
      version: nextVersion,
      contentKey: contentKeyFor(id),
    },
  });

  await appendAudit({
    actor: session.user.id,
    action: "knowledge.save",
    subject: id,
    payload: { filename: file.filename, version: nextVersion, hash },
  });

  return NextResponse.json(updated);
}
