import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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

const ACTIVE = [
  "running",
  "in_development",
  "ai_coding",
  "security_scan",
  "ai_reviewing",
  "test_design",
  "testing",
  "ci_running",
] as const;
const WAITING = [
  "waiting_info",
  "waiting_po",
  "waiting_tech_lead",
  "waiting_qa",
  "waiting_qa_results",
  "waiting_pr_approval",
] as const;
const BLOCKED = ["blocked", "failed"] as const;

export default async function DashboardPage() {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const [active, waiting, blocked, doneToday, recent] = await Promise.all([
    db.workflowRun.count({ where: { status: { in: [...ACTIVE] } } }),
    db.workflowRun.count({ where: { status: { in: [...WAITING] } } }),
    db.workflowRun.count({ where: { status: { in: [...BLOCKED] } } }),
    db.workflowRun.count({
      where: { status: "done", completedAt: { gte: startOfDay } },
    }),
    db.workflowRun.findMany({
      where: { status: { notIn: ["done", "cancelled"] } },
      orderBy: { startedAt: "desc" },
      take: 20,
    }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Pano</h1>
        <p className="text-sm text-muted-foreground">Anlık iş akışı durumu ve günlük özet.</p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Aktif" value={active} tone="primary" />
        <Stat label="Bekliyor" value={waiting} tone="warning" />
        <Stat label="Bloke / Hatalı" value={blocked} tone="destructive" />
        <Stat label="Bugün Tamamlanan" value={doneToday} tone="success" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Aktif İş Akışları</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {recent.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">Aktif iş akışı yok.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Jira Bileti</TableHead>
                  <TableHead>Proje</TableHead>
                  <TableHead>Durum</TableHead>
                  <TableHead>Mod</TableHead>
                  <TableHead>Adım</TableHead>
                  <TableHead>Başlama</TableHead>
                  <TableHead className="text-right">Maliyet</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recent.map((r) => (
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
                    <TableCell className="text-xs">{r.currentStep}</TableCell>
                    <TableCell className="text-xs">{formatRelative(r.startedAt)}</TableCell>
                    <TableCell className="text-right text-xs">
                      ${(r.tokenCostUsdCents / 100).toFixed(2)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "primary" | "warning" | "destructive" | "success";
}) {
  const toneCls =
    tone === "primary"
      ? "text-primary"
      : tone === "warning"
        ? "text-warning"
        : tone === "destructive"
          ? "text-destructive"
          : "text-success";
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </div>
        <div className={`mt-1 text-3xl font-semibold tabular-nums ${toneCls}`}>{value}</div>
      </CardContent>
    </Card>
  );
}
