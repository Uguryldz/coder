import { db } from "@/lib/db";
import { RoutingRulesClient } from "./routing-rules-client";

export const dynamic = "force-dynamic";

export default async function RoutingRulesPage() {
  const [rules, variants] = await Promise.all([
    db.routingRule.findMany({
      include: { variant: true },
      orderBy: [{ active: "desc" }, { priority: "asc" }],
    }),
    db.agentVariant.findMany({
      where: { active: true },
      orderBy: [{ role: "asc" }, { name: "asc" }],
    }),
  ]);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Yönlendirme Kuralları</h1>
        <p className="text-sm text-muted-foreground">
          Etiket / bileşen / proje / iş tipine göre varyant eşlemeleri.
        </p>
      </div>
      <RoutingRulesClient
        rules={rules.map((r) => ({
          id: r.id,
          name: r.name,
          priority: r.priority,
          matchLabel: r.matchLabel,
          matchComponent: r.matchComponent,
          matchProject: r.matchProject,
          matchWorkType: r.matchWorkType,
          workMode: r.workMode,
          active: r.active,
          variantId: r.variantId,
          variantName: r.variant.displayName,
          variantRole: r.variant.role,
        }))}
        variants={variants.map((v) => ({
          id: v.id,
          label: `${v.role} · ${v.displayName}`,
        }))}
      />
    </div>
  );
}
