/**
 * POST /api/jira/test
 *
 * Jira bağlantısını doğrular. Üç auth modunu destekler:
 *   - basic      : Server/DC, username + password
 *   - api_token  : Cloud, email + API token (HTTP Basic wire)
 *   - pat        : DC 8.14+ Personal Access Token (Bearer)
 *
 * /rest/api/2/myself çağrısı yapar — başarılıysa kullanıcı bilgisini döner.
 */
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { z } from "zod";

const Body = z.object({
  authMode: z.enum(["basic", "api_token", "pat"]),
  baseUrl: z.string().url(),
  username: z.string().optional().default(""),
  apiToken: z.string().min(1),
});

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let input: z.infer<typeof Body>;
  try {
    input = Body.parse(await req.json());
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  const base = input.baseUrl.replace(/\/+$/, "");
  const url = `${base}/rest/api/2/myself`;

  const headers: Record<string, string> = { Accept: "application/json" };
  if (input.authMode === "pat") {
    headers.Authorization = `Bearer ${input.apiToken}`;
  } else {
    if (!input.username) {
      return NextResponse.json(
        { error: `${input.authMode} için kullanıcı adı/e-posta zorunlu` },
        { status: 400 },
      );
    }
    const basic = Buffer.from(`${input.username}:${input.apiToken}`).toString("base64");
    headers.Authorization = `Basic ${basic}`;
  }

  try {
    const res = await fetch(url, { headers });
    const text = await res.text();
    if (!res.ok) {
      return NextResponse.json(
        {
          error: `HTTP ${res.status}`,
          hint: hintForStatus(res.status, input.authMode),
          body: text.slice(0, 400),
        },
        { status: 200 },
      );
    }
    const me = JSON.parse(text) as {
      displayName?: string;
      name?: string;
      emailAddress?: string;
      accountId?: string;
      key?: string;
    };
    return NextResponse.json({
      ok: true,
      user: {
        displayName: me.displayName ?? me.name ?? "(unknown)",
        email: me.emailAddress,
        accountId: me.accountId ?? me.key,
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message, hint: "Ağ / DNS / TLS hatası — base URL erişilebilir mi?" },
      { status: 200 },
    );
  }
}

function hintForStatus(status: number, mode: string): string {
  if (status === 401) {
    if (mode === "basic")
      return "Cloud ise basic auth kapalı — API Token moduna geç. Server/DC ise kullanıcı/şifre hatalı.";
    if (mode === "api_token")
      return "E-posta + API Token eşleşmedi. Token id.atlassian.com/manage-profile/security/api-tokens'dan üretilmeli.";
    return "PAT geçersiz veya süresi dolmuş. DC 8.14+ gerekir.";
  }
  if (status === 403) return "Yetki yetersiz — kullanıcının Browse Project yetkisi var mı?";
  if (status === 404) return "URL yanlış. Cloud için https://sirket.atlassian.net olmalı.";
  return "Jira yanıtı ekte — log'ları kontrol et.";
}
