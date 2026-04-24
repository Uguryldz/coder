import { appendAudit } from "@/lib/audit";
import { db } from "@/lib/db";
import { authOptions } from "@/lib/auth";
import crypto from "node:crypto";
import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { z } from "zod";

const Body = z.object({
  role: z.enum([
    "intake",
    "analyst",
    "developer",
    "dev_reviewer",
    "test_designer",
    "test_reviewer",
    "test_runner",
  ]),
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "küçük harf + rakam + tire"),
  displayName: z.string().min(1).max(128).optional(),
  description: z.string().max(500).nullable().optional(),
  cloneFromVariantId: z.string().nullable().optional(),
});

const DEFAULT_PROMPT: Record<string, { prompt: string; model: string }> = {
  intake: {
    prompt: "Sen bir karşılama analistisin. Verilen Jira bileti başlamaya yeterli mi kontrol et.",
    model: "claude-haiku-4-5-20251001",
  },
  analyst: {
    prompt: "Sen kıdemli bir iş+teknik analistsin. analysisDoc + technicalDesign + acceptanceCriteria üret.",
    model: "claude-opus-4-7",
  },
  developer: {
    prompt: "Sen kıdemli bir developer'sın. Verilen analiz + teknik tasarımdan unified diff patch üret.",
    model: "claude-opus-4-7",
  },
  dev_reviewer: {
    prompt: "Sen kıdemli bir kod incelemecisin. Patch'i analiz ile kıyasla, verdict + comments üret.",
    model: "claude-opus-4-7",
  },
  test_designer: {
    prompt:
      "Test senaryoları tasarlarsın. Her scenario için gherkin + code (test framework'e uygun) üret. Pyramid: >=1 unit + integration + e2e + negatif.",
    model: "claude-opus-4-7",
  },
  test_reviewer: {
    prompt: "Test senaryolarını incelersin. Coverage + pyramid + negatif kontrolü.",
    model: "claude-sonnet-4-6",
  },
  test_runner: {
    prompt: "Test senaryolarını sandbox'ta koşturur + coverage ve flaky tespit edersin.",
    model: "claude-sonnet-4-6",
  },
};

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const role = (session.user as { role?: string }).role;
  if (role !== "admin" && role !== "team_lead") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (e) {
    return NextResponse.json({ error: String((e as Error).message) }, { status: 400 });
  }

  // Unique check
  const dup = await db.agentVariant.findFirst({
    where: { role: body.role, name: body.name },
  });
  if (dup) return NextResponse.json({ error: "variant zaten var" }, { status: 409 });

  // Clone source
  let sourcePrompt = DEFAULT_PROMPT[body.role] ?? { prompt: "", model: "claude-sonnet-4-6" };
  let sourceKnowledgeLinks: Array<{ knowledgeFileId: string }> = [];
  if (body.cloneFromVariantId) {
    const src = await db.agentVariant.findUnique({
      where: { id: body.cloneFromVariantId },
      include: { activeVersion: true, knowledgeLinks: true },
    });
    if (!src) return NextResponse.json({ error: "kaynak variant yok" }, { status: 404 });
    if (src.activeVersion) {
      sourcePrompt = {
        prompt: src.activeVersion.systemPrompt,
        model: src.activeVersion.model,
      };
    }
    sourceKnowledgeLinks = src.knowledgeLinks.map((l) => ({ knowledgeFileId: l.knowledgeFileId }));
  }

  const variant = await db.agentVariant.create({
    data: {
      role: body.role,
      name: body.name,
      displayName: body.displayName ?? body.name,
      description: body.description ?? null,
      active: true,
    },
  });

  const knowledgeHash = crypto
    .createHash("sha256")
    .update(`${body.role}:${body.name}:new`)
    .digest("hex");

  const version = await db.promptVersion.create({
    data: {
      variantId: variant.id,
      version: 1,
      systemPrompt: sourcePrompt.prompt,
      model: sourcePrompt.model,
      temperature: 0.2,
      maxTokens: 4096,
      knowledgeHash,
      createdBy: session.user.email ?? "unknown",
      notes: body.cloneFromVariantId ? `cloned from ${body.cloneFromVariantId}` : "initial",
    },
  });

  await db.agentVariant.update({
    where: { id: variant.id },
    data: { activeVersionId: version.id },
  });

  // Clone knowledge links
  if (sourceKnowledgeLinks.length > 0) {
    await db.variantKnowledgeLink.createMany({
      data: sourceKnowledgeLinks.map((l) => ({
        variantId: variant.id,
        knowledgeFileId: l.knowledgeFileId,
      })),
      skipDuplicates: true,
    });
  }

  await appendAudit({
    actor: session.user.email ?? "unknown",
    action: "variant.created",
    subject: variant.id,
    payload: { role: variant.role, name: variant.name, clonedFrom: body.cloneFromVariantId ?? null },
  });

  return NextResponse.json({ id: variant.id, versionId: version.id });
}
