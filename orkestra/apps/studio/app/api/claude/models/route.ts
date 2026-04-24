/**
 * GET /api/claude/models?apiKey=xxx
 *   Anthropic API'den model listesi çeker.
 *   - sk-ant-api...  → x-api-key header
 *   - sk-ant-oat...  → Authorization: Bearer + anthropic-beta: oauth-2025-04-20
 */
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

interface AnthropicModel {
  id: string;
  display_name: string;
  type?: string;
  created_at?: string;
}

function buildAuthHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { "anthropic-version": "2023-06-01" };
  if (apiKey.startsWith("sk-ant-oat")) {
    headers["Authorization"] = `Bearer ${apiKey}`;
    headers["anthropic-beta"] = "oauth-2025-04-20";
  } else {
    headers["x-api-key"] = apiKey;
  }
  return headers;
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  let apiKey = (url.searchParams.get("apiKey") ?? "").trim();

  if (!apiKey) {
    const setting = await db.setting.findUnique({ where: { key: "claude" } });
    if (setting && typeof setting.value === "object" && setting.value) {
      apiKey = ((setting.value as { apiKey?: string }).apiKey ?? "").trim();
    }
  }
  if (!apiKey) apiKey = (process.env.ANTHROPIC_API_KEY ?? "").trim();

  if (!apiKey) {
    return NextResponse.json({ error: "Token gerekli" }, { status: 400 });
  }

  try {
    const resp = await fetch("https://api.anthropic.com/v1/models?limit=100", {
      headers: buildAuthHeaders(apiKey),
    });
    if (!resp.ok) {
      const txt = await resp.text();
      return NextResponse.json(
        { error: `Anthropic ${resp.status}: ${txt.slice(0, 300)}` },
        { status: resp.status },
      );
    }
    const data = (await resp.json()) as { data?: AnthropicModel[] };
    const models = (data.data ?? []).map((m) => ({
      id: m.id,
      displayName: m.display_name,
      createdAt: m.created_at,
    }));
    models.sort((a, b) => {
      const tierOf = (id: string) =>
        id.includes("opus") ? 0 : id.includes("sonnet") ? 1 : id.includes("haiku") ? 2 : 3;
      const t = tierOf(a.id) - tierOf(b.id);
      if (t !== 0) return t;
      return (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
    });
    return NextResponse.json({
      models,
      count: models.length,
      authMode: apiKey.startsWith("sk-ant-oat") ? "oauth" : "api-key",
    });
  } catch (e) {
    return NextResponse.json({ error: `Anthropic fetch: ${(e as Error).message}` }, { status: 500 });
  }
}
