import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { db } from "@/lib/db";
import { WORKFLOW_STATUS_LABELS, WORK_MODE_LABELS } from "@/lib/role-meta";
import { formatRelative } from "@/lib/utils";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function WorkflowsPage() {
  const runs = await db.workflowRun.findMany({
    orderBy: { startedAt: "desc" },
    take: 100,
  });
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">İş Akışları</h1>
        <p className="text-sm text-muted-foreground">Son 100 çalışma kaydı.</p>
      </div>
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Bilet</TableHead>
                <TableHead>Proje</TableHead>
                <TableHead>Durum</TableHead>
                <TableHead>Mod</TableHead>
                <TableHead>Başlama</TableHead>
                <TableHead>Bitiş</TableHead>
                <TableHead className="text-right">Maliyet</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    <Link
                      href={`/workflows/${r.id}`}
                      className="font-mono text-xs text-primary hover:underline"
                    >
                      {r.jiraTicketId}
                    </Link>
                  </TableCell>
                  <TableCell className="text-xs">{r.jiraProjectKey}</TableCell>
                  <TableCell>
                    <Badge variant="secondary" className="text-[10px]">
                      {WORKFLOW_STATUS_LABELS[r.status] ?? r.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs">
                    {WORK_MODE_LABELS[r.workMode] ?? r.workMode}
                  </TableCell>
                  <TableCell className="text-xs">{formatRelative(r.startedAt)}</TableCell>
                  <TableCell className="text-xs">
                    {r.completedAt ? formatRelative(r.completedAt) : "-"}
                  </TableCell>
                  <TableCell className="text-right text-xs">
                    ${(r.tokenCostUsdCents / 100).toFixed(2)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
