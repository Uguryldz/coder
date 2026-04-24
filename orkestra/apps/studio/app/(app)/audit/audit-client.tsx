"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { formatDate } from "@/lib/utils";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import * as React from "react";

type Entry = {
  id: string;
  actor: string;
  action: string;
  subject: string | null;
  prevHash: string;
  thisHash: string;
  timestamp: string;
  payload: unknown;
  workflowRunId: string | null;
};

export function AuditClient({ entries }: { entries: Entry[] }) {
  const { push } = useToast();
  const [verifying, setVerifying] = React.useState(false);
  const [result, setResult] = React.useState<null | {
    ok: boolean;
    total: number;
    brokenAt?: string;
  }>(null);
  const [expanded, setExpanded] = React.useState<string | null>(null);

  async function verify() {
    setVerifying(true);
    try {
      const res = await fetch("/api/audit/verify", { method: "POST" });
      const data = await res.json();
      setResult(data);
      if (data.ok) {
        push({
          title: "Zincir doğrulandı",
          description: `${data.total} kayıt bütün.`,
          variant: "success",
        });
      } else {
        push({
          title: "Zincir BOZUK!",
          description: `Bozulma noktası: ${data.brokenAt}`,
          variant: "destructive",
        });
      }
    } finally {
      setVerifying(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground">Son 200 kayıt gösteriliyor.</div>
        <div className="flex items-center gap-3">
          {result && (
            <Badge variant={result.ok ? "success" : "destructive"} className="gap-1">
              {result.ok ? (
                <ShieldCheck className="h-3 w-3" />
              ) : (
                <ShieldAlert className="h-3 w-3" />
              )}
              {result.ok ? `${result.total} kayıt bütün` : `${result.brokenAt} bozuk`}
            </Badge>
          )}
          <Button onClick={verify} disabled={verifying} variant="outline">
            <ShieldCheck className="h-3.5 w-3.5" />
            {verifying ? "Doğrulanıyor..." : "Zinciri Doğrula"}
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Zaman</TableHead>
                <TableHead>Aktör</TableHead>
                <TableHead>Aksiyon</TableHead>
                <TableHead>Konu</TableHead>
                <TableHead>Hash</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((e) => (
                <React.Fragment key={e.id}>
                  <TableRow>
                    <TableCell className="text-xs">{formatDate(e.timestamp)}</TableCell>
                    <TableCell className="font-mono text-xs">{e.actor}</TableCell>
                    <TableCell className="text-xs">{e.action}</TableCell>
                    <TableCell className="font-mono text-xs">{e.subject ?? "-"}</TableCell>
                    <TableCell className="font-mono text-[10px] text-muted-foreground">
                      {e.thisHash.slice(0, 10)}...
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setExpanded((curr) => (curr === e.id ? null : e.id))}
                      >
                        {expanded === e.id ? "Gizle" : "Detay"}
                      </Button>
                    </TableCell>
                  </TableRow>
                  {expanded === e.id && (
                    <TableRow>
                      <TableCell colSpan={6} className="bg-secondary/30">
                        <pre className="whitespace-pre-wrap break-all text-[11px]">
                          {JSON.stringify(
                            {
                              prevHash: e.prevHash,
                              thisHash: e.thisHash,
                              workflowRunId: e.workflowRunId,
                              payload: e.payload,
                            },
                            null,
                            2,
                          )}
                        </pre>
                      </TableCell>
                    </TableRow>
                  )}
                </React.Fragment>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
