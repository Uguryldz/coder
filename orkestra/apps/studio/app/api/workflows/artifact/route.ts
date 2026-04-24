import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * Thin pass-through for artifact fetch. The studio does not hold MinIO creds;
 * instead it asks the worker's read endpoint, if configured. Gracefully
 * 404s when no backend is configured so the UI can fall back to "no preview".
 */
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const key = url.searchParams.get("key");
  if (!key) return NextResponse.json({ error: "key required" }, { status: 400 });

  const backendUrl = process.env.ORKESTRA_WORKER_URL;
  if (!backendUrl) {
    return new NextResponse("Artifact depolama yapılandırılmamış.", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  try {
    const res = await fetch(`${backendUrl}/artifacts?key=${encodeURIComponent(key)}`, {
      method: "GET",
    });
    if (!res.ok) {
      return new NextResponse("Çıktı bulunamadı", { status: res.status });
    }
    const text = await res.text();
    return new NextResponse(text, {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  } catch (err) {
    return new NextResponse(`Çıktı alınamadı: ${String(err)}`, { status: 502 });
  }
}
