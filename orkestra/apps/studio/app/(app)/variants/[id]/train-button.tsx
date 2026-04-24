"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";

interface Props {
  variantId: string;
  variantName: string;
}

export function TrainButton({ variantId, variantName }: Props) {
  const { push } = useToast();
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [hint, setHint] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [proposed, setProposed] = React.useState<string | null>(null);
  const [notes, setNotes] = React.useState<string>("");

  async function runTrain() {
    setBusy(true);
    setProposed(null);
    setNotes("");
    try {
      const res = await fetch(`/api/variants/${variantId}/train`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hint }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      const data = await res.json();
      setProposed(data.proposedPrompt);
      setNotes(data.notes ?? "");
    } catch (e) {
      push({ title: "Öğrenme başarısız", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function publishProposed() {
    if (!proposed) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/prompt-versions/publish`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          variantId,
          systemPrompt: proposed,
          notes: `AI Öğren: ${notes || "auto-improved"}`,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      push({ title: "Yeni sürüm aktif", description: "AI önerisi yayımlandı" });
      setOpen(false);
      setProposed(null);
      router.refresh();
    } catch (e) {
      push({ title: "Yayımlama başarısız", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Sparkles className="mr-1 h-4 w-4" /> Öğren
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>AI ile Variant'ı Öğret</DialogTitle>
          <DialogDescription>
            Mevcut persona + knowledge pack + son workflow sonuçları incelenerek yeni bir
            persona önerisi üretilir. Onaylarsan immutable yeni sürüm olarak yayımlanır.
            <code className="ml-1">{variantName}</code>
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label>Niyet / Hint (opsiyonel)</Label>
            <Textarea
              rows={3}
              value={hint}
              onChange={(e) => setHint(e.target.value)}
              placeholder="örn. 'accessibility kurallarını daha sert yorumla', 'kısa cevap ver', 'prompt injection korumalı olsun'"
              disabled={busy || Boolean(proposed)}
            />
            <p className="text-xs text-muted-foreground">
              AI bu ipucu + knowledge pack + geçmiş step çıktılarını birlikte değerlendirir.
            </p>
          </div>

          {!proposed ? (
            <div className="flex justify-end">
              <Button onClick={runTrain} disabled={busy}>
                {busy ? "AI çalışıyor..." : "Öneri Üret"}
              </Button>
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-1.5">
                <Label>AI Önerisi (yeni system prompt)</Label>
                <Textarea
                  value={proposed}
                  onChange={(e) => setProposed(e.target.value)}
                  rows={12}
                  className="font-mono text-xs"
                />
              </div>
              {notes && (
                <div className="text-xs text-muted-foreground">
                  <Label className="mb-1 block">Not</Label>
                  {notes}
                </div>
              )}
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
            İptal
          </Button>
          {proposed && (
            <>
              <Button variant="outline" onClick={() => setProposed(null)} disabled={busy}>
                Yeniden
              </Button>
              <Button onClick={publishProposed} disabled={busy}>
                {busy ? "Yayımlanıyor..." : "Yeni Sürüm Olarak Yayımla"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
