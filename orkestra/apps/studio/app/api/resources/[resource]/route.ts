import { appendAudit } from "@/lib/audit";
import { authOptions, canWrite } from "@/lib/auth";
import { db } from "@/lib/db";
import { resolveResource } from "@/lib/resources";
import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ resource: string }> };

function parseFilters(raw: string | null): Array<{
  field: string;
  operator: string;
  value: unknown;
}> {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function buildPrismaWhere(filters: Array<{ field: string; operator: string; value: unknown }>) {
  const where: Record<string, unknown> = {};
  for (const f of filters) {
    if (!f.field || f.value === undefined || f.value === null || f.value === "") continue;
    switch (f.operator) {
      case "eq":
        where[f.field] = f.value;
        break;
      case "ne":
        where[f.field] = { not: f.value };
        break;
      case "contains":
        where[f.field] = { contains: String(f.value), mode: "insensitive" };
        break;
      case "in":
        where[f.field] = { in: Array.isArray(f.value) ? f.value : [f.value] };
        break;
      case "gte":
        where[f.field] = { gte: f.value };
        break;
      case "lte":
        where[f.field] = { lte: f.value };
        break;
      default:
        where[f.field] = f.value;
    }
  }
  return where;
}

function delegate(resource: string) {
  const modelKey = resolveResource(resource);
  if (!modelKey) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const any = db as any;
  return any[modelKey] as
    | {
        findMany: (args?: unknown) => Promise<unknown[]>;
        count: (args?: unknown) => Promise<number>;
        create: (args: unknown) => Promise<unknown>;
      }
    | undefined;
}

export async function GET(request: Request, ctx: Ctx) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { resource } = await ctx.params;
  const model = delegate(resource);
  if (!model) return NextResponse.json({ error: "unknown resource" }, { status: 404 });

  const url = new URL(request.url);
  const start = Number(url.searchParams.get("_start") ?? 0);
  const end = Number(url.searchParams.get("_end") ?? 50);
  const sort = url.searchParams.get("_sort") ?? undefined;
  const order = (url.searchParams.get("_order") as "asc" | "desc" | null) ?? "desc";
  const idsRaw = url.searchParams.get("ids");
  const filters = parseFilters(url.searchParams.get("filters"));
  const where = buildPrismaWhere(filters);

  const take = Math.max(1, Math.min(500, end - start));
  const skip = Math.max(0, start);

  if (idsRaw) {
    const ids = JSON.parse(idsRaw) as string[];
    const rows = await model.findMany({ where: { id: { in: ids } } });
    return NextResponse.json({ data: bigintSafe(rows) });
  }

  const [data, total] = await Promise.all([
    model.findMany({
      where,
      orderBy: sort ? { [sort]: order } : undefined,
      skip,
      take,
    }),
    model.count({ where }),
  ]);

  return NextResponse.json({ data: bigintSafe(data), total });
}

export async function POST(request: Request, ctx: Ctx) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!canWrite(session.user.role))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { resource } = await ctx.params;
  const model = delegate(resource);
  if (!model) return NextResponse.json({ error: "unknown resource" }, { status: 404 });

  const body = await request.json();
  const created = await model.create({ data: body });
  await appendAudit({
    actor: session.user.id,
    action: `create:${resource}`,
    subject: (created as { id?: string }).id,
    payload: { resource, body },
  });
  return NextResponse.json(bigintSafe(created));
}

function bigintSafe<T>(val: T): T {
  return JSON.parse(JSON.stringify(val, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}
