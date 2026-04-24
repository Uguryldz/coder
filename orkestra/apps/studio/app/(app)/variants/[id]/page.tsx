import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { db } from "@/lib/db";
import { ROLE_LABELS, type AgentRole } from "@/lib/role-meta";
import { ChevronLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { TrainButton } from "./train-button";
import { VariantTabs } from "./variant-tabs";

export const dynamic = "force-dynamic";

type Params = { id: string };

export default async function VariantDetailPage({ params }: { params: Promise<Params> }) {
  const { id } = await params;
  const variant = await db.agentVariant.findUnique({
    where: { id },
    include: {
      activeVersion: true,
      versions: { orderBy: { version: "desc" }, take: 30 },
      knowledgeLinks: {
        include: { knowledgeFile: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!variant) notFound();

  const [sharedKnowledge, goldenTickets] = await Promise.all([
    db.knowledgeFile.findMany({
      where: { scope: "shared" },
      orderBy: [{ category: "asc" }, { filename: "asc" }],
    }),
    db.goldenTicket.findMany({ orderBy: { createdAt: "desc" }, take: 100 }),
  ]);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Link
          href="/variants"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-3 w-3" /> Varyantlar
        </Link>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">{variant.displayName}</h1>
            <Badge variant="secondary">
              {ROLE_LABELS[variant.role as AgentRole] ?? variant.role}
            </Badge>
            <code className="rounded bg-secondary px-1.5 py-0.5 text-xs">{variant.name}</code>
            {variant.activeVersion && (
              <Badge variant="success">aktif v{variant.activeVersion.version}</Badge>
            )}
            {!variant.active && <Badge variant="destructive">pasif</Badge>}
          </div>
          <TrainButton variantId={variant.id} variantName={variant.name} />
        </div>
        {variant.description && (
          <p className="mt-1 text-sm text-muted-foreground">{variant.description}</p>
        )}
      </div>

      <Card>
        <CardContent className="p-4">
          <VariantTabs
            variant={{
              id: variant.id,
              name: variant.name,
              role: variant.role,
              activeVersion: variant.activeVersion
                ? {
                    id: variant.activeVersion.id,
                    version: variant.activeVersion.version,
                    systemPrompt: variant.activeVersion.systemPrompt,
                    model: variant.activeVersion.model,
                    temperature: variant.activeVersion.temperature,
                    maxTokens: variant.activeVersion.maxTokens,
                  }
                : null,
              versions: variant.versions.map((v) => ({
                id: v.id,
                version: v.version,
                model: v.model,
                createdAt: v.createdAt.toISOString(),
              })),
              knowledgeFiles: variant.knowledgeLinks.map((l) => ({
                id: l.knowledgeFileId,
                filename: l.knowledgeFile.filename,
                category: l.knowledgeFile.category,
                scope: l.knowledgeFile.scope,
                version: l.knowledgeFile.version,
              })),
            }}
            sharedFiles={sharedKnowledge.map((f) => ({
              id: f.id,
              filename: f.filename,
              category: f.category,
            }))}
            goldenTickets={goldenTickets.map((t) => ({
              id: t.id,
              title: t.title,
              category: t.category,
            }))}
          />
        </CardContent>
      </Card>
    </div>
  );
}
