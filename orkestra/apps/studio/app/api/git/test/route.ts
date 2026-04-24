/**
 * POST /api/git/test
 * Git platform bağlantı testi — basic auth ile repo listesini çeker.
 * Desteklenen platformlar: Bitbucket DC, Gitea. GitHub/GitLab stub.
 */
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { z } from "zod";

const Body = z.object({
  platform: z.enum(["bitbucket", "github", "gitlab", "gitea"]),
  baseUrl: z.string().url(),
  username: z.string().min(1),
  appPassword: z.string().min(1),
});

interface RepoItem {
  name: string;
  slug: string;
  project: string;
}

async function listBitbucket(baseUrl: string, auth: string): Promise<RepoItem[]> {
  // Bitbucket DC: /rest/api/1.0/repos (tüm repolar, sayfalama)
  const url = `${baseUrl.replace(/\/$/, "")}/rest/api/1.0/repos?limit=50`;
  const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
  if (!res.ok) throw new Error(`Bitbucket ${res.status}: ${await res.text().then((t) => t.slice(0, 200))}`);
  const data = (await res.json()) as {
    values?: Array<{ name: string; slug: string; project?: { key: string } }>;
  };
  return (data.values ?? []).map((r) => ({
    name: r.name,
    slug: r.slug,
    project: r.project?.key ?? "-",
  }));
}

async function listGitea(baseUrl: string, auth: string): Promise<RepoItem[]> {
  // Gitea: /api/v1/repos/search
  const url = `${baseUrl.replace(/\/$/, "")}/api/v1/repos/search?limit=50`;
  const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
  if (!res.ok) throw new Error(`Gitea ${res.status}: ${await res.text().then((t) => t.slice(0, 200))}`);
  const data = (await res.json()) as {
    data?: Array<{ name: string; full_name: string; owner?: { username: string } }>;
  };
  return (data.data ?? []).map((r) => ({
    name: r.name,
    slug: r.name,
    project: r.owner?.username ?? r.full_name.split("/")[0] ?? "-",
  }));
}

async function listGitHub(auth: string): Promise<RepoItem[]> {
  // Basic auth deprecated; ama app password bir PAT ise Authorization: token X çalışır
  const token = Buffer.from(auth, "base64").toString().split(":")[1] ?? "";
  const res = await fetch("https://api.github.com/user/repos?per_page=50", {
    headers: { Authorization: `token ${token}`, Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${await res.text().then((t) => t.slice(0, 200))}`);
  const data = (await res.json()) as Array<{ name: string; full_name: string; owner: { login: string } }>;
  return data.map((r) => ({ name: r.name, slug: r.name, project: r.owner.login }));
}

async function listGitLab(baseUrl: string, auth: string): Promise<RepoItem[]> {
  const token = Buffer.from(auth, "base64").toString().split(":")[1] ?? "";
  const url = `${baseUrl.replace(/\/$/, "")}/api/v4/projects?membership=true&per_page=50`;
  const res = await fetch(url, { headers: { "PRIVATE-TOKEN": token } });
  if (!res.ok) throw new Error(`GitLab ${res.status}: ${await res.text().then((t) => t.slice(0, 200))}`);
  const data = (await res.json()) as Array<{
    name: string;
    path: string;
    namespace?: { path: string };
  }>;
  return data.map((r) => ({ name: r.name, slug: r.path, project: r.namespace?.path ?? "-" }));
}

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
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  const auth = Buffer.from(`${body.username}:${body.appPassword}`).toString("base64");

  try {
    let repos: RepoItem[];
    if (body.platform === "bitbucket") repos = await listBitbucket(body.baseUrl, auth);
    else if (body.platform === "gitea") repos = await listGitea(body.baseUrl, auth);
    else if (body.platform === "github") repos = await listGitHub(auth);
    else repos = await listGitLab(body.baseUrl, auth);
    return NextResponse.json({ ok: true, repos, platform: body.platform });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
