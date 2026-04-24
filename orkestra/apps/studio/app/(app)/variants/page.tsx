import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { db } from "@/lib/db";
import { AGENT_ROLES, ROLE_DESCRIPTIONS, ROLE_LABELS, type AgentRole } from "@/lib/role-meta";
import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { NewVariantButton } from "./new-variant-button";

export const dynamic = "force-dynamic";

export default async function VariantsPage() {
  const variants = await db.agentVariant.findMany({
    include: { activeVersion: true },
    orderBy: [{ role: "asc" }, { name: "asc" }],
  });

  const byRole: Record<AgentRole, typeof variants> = {
    intake: [],
    analyst: [],
    developer: [],
    dev_reviewer: [],
    test_designer: [],
    test_reviewer: [],
    test_runner: [],
  };
  for (const v of variants) {
    byRole[v.role as AgentRole].push(v);
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Ajan Varyantları</h1>
          <p className="text-sm text-muted-foreground">
            7 rol için tanımlı varyantlar ve aktif prompt sürümleri.
          </p>
        </div>
        <NewVariantButton />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {AGENT_ROLES.map((role) => {
          const items = byRole[role];
          return (
            <Card key={role}>
              <CardHeader>
                <CardTitle>{ROLE_LABELS[role]}</CardTitle>
                <p className="text-xs text-muted-foreground mt-1">{ROLE_DESCRIPTIONS[role]}</p>
              </CardHeader>
              <CardContent className="p-0">
                {items.length === 0 ? (
                  <p className="p-4 text-sm text-muted-foreground">Varyant yok</p>
                ) : (
                  <ul className="divide-y divide-border">
                    {items.map((v) => (
                      <li key={v.id}>
                        <Link
                          href={`/variants/${v.id}`}
                          className="flex items-center justify-between px-4 py-3 hover:bg-secondary/60"
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium">{v.displayName}</span>
                              <code className="rounded bg-secondary px-1 text-[10px]">
                                {v.name}
                              </code>
                              {!v.active && (
                                <Badge variant="secondary" className="text-[10px]">
                                  pasif
                                </Badge>
                              )}
                            </div>
                            <div className="mt-0.5 text-xs text-muted-foreground">
                              {v.activeVersion ? (
                                <>
                                  aktif v{v.activeVersion.version} · {v.activeVersion.model}
                                </>
                              ) : (
                                <span className="text-warning">aktif sürüm yok</span>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            {v.activeVersion && (
                              <Badge variant="success" className="text-[10px]">
                                v{v.activeVersion.version}
                              </Badge>
                            )}
                            <ChevronRight className="h-4 w-4 text-muted-foreground" />
                          </div>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
