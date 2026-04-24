import { appendAudit } from "@/lib/audit";
import { authOptions, canWrite } from "@/lib/auth";
import { db } from "@/lib/db";
import { resolvePk, resolveResource } from "@/lib/resources";
import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ resource: string; id: string }> };

function delegate(resource: string) {
  const modelKey = resolveResource(resource);
  if (!modelKey) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const any = db as any;
  return any[modelKey] as
    | {
        findUnique: (args: unknown) => Promise<unknown>;
        update: (args: unknown) => Promise<unknown>;
        delete: (args: unknown) => Promise<unknown>;
      }
    | undefined;
}

function bigintSafe<T>(val: T): T {
  return JSON.parse(JSON.stringify(val, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

export async function GET(_req: Request, ctx: Ctx) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { resource, id } = await ctx.params;
  const model = delegate(resource);
  if (!model) return NextResponse.json({ error: "unknown resource" }, { status: 404 });
  const pk = resolvePk(resource);
  const row = await model.findUnique({ where: { [pk]: id } });
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(bigintSafe(row));
}

export async function PATCH(req: Request, ctx: Ctx) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!canWrite(session.user.role))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { resource, id } = await ctx.params;
  const model = delegate(resource);
  if (!model) return NextResponse.json({ error: "unknown resource" }, { status: 404 });
  const body = await req.json();
  const pk = resolvePk(resource);
  const updated = await model.update({ where: { [pk]: id }, data: body });
  await appendAudit({
    actor: session.user.id,
    action: `update:${resource}`,
    subject: id,
    payload: { resource, patch: body },
  });
  return NextResponse.json(bigintSafe(updated));
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!canWrite(session.user.role))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { resource, id } = await ctx.params;
  const model = delegate(resource);
  if (!model) return NextResponse.json({ error: "unknown resource" }, { status: 404 });
  const pk = resolvePk(resource);
  const deleted = await model.delete({ where: { [pk]: id } });
  await appendAudit({
    actor: session.user.id,
    action: `delete:${resource}`,
    subject: id,
    payload: { resource },
  });
  return NextResponse.json(bigintSafe(deleted));
}
