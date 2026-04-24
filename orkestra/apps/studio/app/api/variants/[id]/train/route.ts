/**
 * POST /api/variants/[id]/train
 * AI ile mevcut persona + knowledge pack + recent outputs'tan yeni persona önerisi üretir.
 *
 * Akış:
 *  1. Variant + activeVersion + knowledge linklerini yükle
 *  2. Son 5 StepExecution çıktısını topla (varsa)
 *  3. Claude'a "bu persona'yı iyileştir" meta-prompt gönder
 *  4. Önerilen prompt'u caller'a döndür (yayımlama ayrı endpoint)
 *
 * Mock LLM modunda basit deterministik öneri döner.
 */
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { appendAudit } from "@/lib/audit";
import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { z } from "zod";

const Body = z.object({ hint: z.string().max(1000).optional() });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const role = (session.user as { role?: string }).role;
  if (role !== "admin" && role !== "team_lead") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { hint } = Body.parse(await req.json().catch(() => ({})));

  const variant = await db.agentVariant.findUnique({
    where: { id },
    include: {
      activeVersion: true,
      knowledgeLinks: { include: { knowledgeFile: true } },
    },
  });
  if (!variant) return NextResponse.json({ error: "variant yok" }, { status: 404 });
  if (!variant.activeVersion) {
    return NextResponse.json({ error: "aktif sürüm yok" }, { status: 400 });
  }

  // Son step execution'ları (bu variant için)
  const recent = await db.stepExecution.findMany({
    where: { variantId: id, status: "success" },
    orderBy: { startedAt: "desc" },
    take: 5,
  });

  const knowledgeFiles = await db.knowledgeFile.findMany({
    where: {
      OR: [
        { scope: "variant", ownerId: id },
        { id: { in: variant.knowledgeLinks.map((l) => l.knowledgeFileId) } },
      ],
    },
  });

  const llmMode = process.env.LLM_MODE ?? "mock";
  const apiKey = process.env.ANTHROPIC_API_KEY ?? "";

  const currentPrompt = variant.activeVersion.systemPrompt;
  const model = variant.activeVersion.model;

  // Mock modunda deterministik iyileştirilmiş öneri üret
  if (llmMode === "mock" || !apiKey) {
    const stamp = new Date().toISOString();
    const proposed =
      `# ${variant.displayName} — v${variant.activeVersion.version + 1} (AI-assisted)\n\n` +
      currentPrompt +
      `\n\n## Ek Kurallar (${stamp})\n` +
      `- Çıktı her zaman Zod şemasıyla uyumlu JSON olmalı.\n` +
      `- Bilinmeyen durumları tahmin etme, knowledge pack'e başvur.\n` +
      (hint ? `- Kullanıcı ipucu: ${hint}\n` : "") +
      `- ${knowledgeFiles.length} knowledge dosyası dikkate alındı.\n` +
      `- Son ${recent.length} step incelendi.\n`;

    await appendAudit({
      actor: session.user.email ?? "unknown",
      action: "variant.train.mock",
      subject: id,
      payload: { hint: hint ?? null, knowledgeCount: knowledgeFiles.length, recentCount: recent.length },
    });

    return NextResponse.json({
      proposedPrompt: proposed,
      notes: `Mock öneri — LLM_MODE=mock. Gerçek AI önerisi için ANTHROPIC_API_KEY ayarla ve LLM_MODE=real yap.`,
      model,
    });
  }

  // Gerçek Claude çağrısı
  const meta = `Sen bir prompt mühendisisin. Aşağıdaki AI ajanının persona/system prompt'unu ince ayarla.

## Rol
${variant.role}

## Variant
${variant.displayName} (${variant.name})

## Mevcut Persona
---
${currentPrompt}
---

## Variant'a Bağlı Knowledge Dosyaları
${knowledgeFiles.length === 0 ? "(yok)" : knowledgeFiles.map((f) => `- [${f.category}] ${f.filename}`).join("\n")}

## Son Step Execution'lar
${recent.length === 0 ? "(yok)" : recent.map((s) => `- ${s.stepName} · tokensIn=${s.tokensIn} · out=${s.tokensOut} · cache=${s.cacheHits}`).join("\n")}

## Kullanıcı İpucu
${hint || "(yok)"}

## Görev
1. Mevcut persona'nın zayıf noktalarını tespit et.
2. Aşağıdaki ilkelere uygun, iyileştirilmiş bir persona metni üret:
   - Structured output (Zod JSON) beklentisine sadık
   - Knowledge pack'e referans ver, tahmin etme
   - Hint varsa uygula
   - Türkçe
3. YALNIZCA yeni persona metnini döndür. Açıklama, başlık, ekstra metin ekleme.
`;

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 2048,
        temperature: 0.3,
        system: "Sen kıdemli bir prompt mühendisisin. Kısa ve öz öneriler üret.",
        messages: [{ role: "user", content: meta }],
      }),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Anthropic ${resp.status}: ${text.slice(0, 300)}`);
    }
    const data = (await resp.json()) as {
      content?: Array<{ type: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const proposed = data.content?.find((b) => b.type === "text")?.text?.trim() ?? "";
    if (!proposed) throw new Error("boş yanıt");

    await appendAudit({
      actor: session.user.email ?? "unknown",
      action: "variant.train.real",
      subject: id,
      payload: {
        hint: hint ?? null,
        tokensIn: data.usage?.input_tokens ?? 0,
        tokensOut: data.usage?.output_tokens ?? 0,
        model,
      },
    });

    return NextResponse.json({
      proposedPrompt: proposed,
      notes: `Claude ${model} önerisi · tokensIn=${data.usage?.input_tokens ?? 0} · tokensOut=${data.usage?.output_tokens ?? 0}`,
      model,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
