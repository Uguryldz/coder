"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { Play } from "lucide-react";
import * as React from "react";
import type { GoldenTicketLite, VariantView } from "./variant-tabs";

export function TestTab({
  variant,
  goldenTickets,
}: {
  variant: VariantView;
  goldenTickets: GoldenTicketLite[];
}) {
  const { push } = useToast();
  const [fromId, setFromId] = React.useState<string>(
    variant.versions[1]?.id ?? variant.versions[0]?.id ?? "",
  );
  const [toId, setToId] = React.useState<string>(variant.versions[0]?.id ?? "");
  const [pickedIds, setPickedIds] = React.useState<Set<string>>(new Set());
  const [running, setRunning] = React.useState(false);
  const [result, setResult] = React.useState<null | {
    id: string;
    overallScore: number | null;
  }>(null);

  function toggle(id: string) {
    setPickedIds((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function runEval() {
    if (!fromId || !toId || pickedIds.size === 0) return;
    setRunning(true);
    setResult(null);
    try {
      const res = await fetch("/api/evaluations/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          variantId: variant.id,
          fromVersionId: fromId,
          toVersionId: toId,
          goldenTicketIds: Array.from(pickedIds),
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "Eval başlatılamadı");
      }
      const data = await res.json();
      setResult({ id: data.id, overallScore: data.overallScore ?? null });
      push({
        title: "Değerlendirme kuyruklandı",
        description: "Sonuçlar işçi tamamladığında güncellenecek.",
        variant: "success",
      });
    } catch (err) {
      push({
        title: "Başarısız",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label>Karşılaştırılacak Sürüm (v_current)</Label>
          <Select value={fromId} onValueChange={setFromId}>
            <SelectTrigger>
              <SelectValue placeholder="Sürüm seçin" />
            </SelectTrigger>
            <SelectContent>
              {variant.versions.map((v) => (
                <SelectItem key={v.id} value={v.id}>
                  v{v.version} · {v.model}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>Aday Sürüm (v_new)</Label>
          <Select value={toId} onValueChange={setToId}>
            <SelectTrigger>
              <SelectValue placeholder="Sürüm seçin" />
            </SelectTrigger>
            <SelectContent>
              {variant.versions.map((v) => (
                <SelectItem key={v.id} value={v.id}>
                  v{v.version} · {v.model}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div>
        <Label>Altın Biletler</Label>
        <div className="mt-2 max-h-72 overflow-y-auto rounded-md border border-border">
          {goldenTickets.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">Tanımlı altın bilet yok.</p>
          ) : (
            <ul className="divide-y divide-border">
              {goldenTickets.map((t) => (
                <li key={t.id} className="flex items-center gap-3 px-3 py-2">
                  <input
                    type="checkbox"
                    checked={pickedIds.has(t.id)}
                    onChange={() => toggle(t.id)}
                    className="h-4 w-4"
                  />
                  <span className="flex-1 text-sm">{t.title}</span>
                  {t.category && (
                    <Badge variant="secondary" className="text-[10px]">
                      {t.category}
                    </Badge>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between border-t border-border pt-4">
        <div className="text-xs text-muted-foreground">{pickedIds.size} bilet seçildi</div>
        <Button
          onClick={runEval}
          disabled={running || !fromId || !toId || pickedIds.size === 0 || fromId === toId}
        >
          <Play className="h-3.5 w-3.5" />
          {running ? "Başlatılıyor..." : "Değerlendirmeyi Çalıştır"}
        </Button>
      </div>

      {result && (
        <div className="rounded-md border border-border bg-secondary/40 px-4 py-3 text-sm">
          <div className="font-medium">Değerlendirme kuyruklandı</div>
          <div className="text-xs text-muted-foreground">
            id: <code>{result.id}</code>
            {result.overallScore !== null && ` · skor: ${result.overallScore}`}
          </div>
        </div>
      )}
    </div>
  );
}
