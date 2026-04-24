"use client";

import { PromptEditor } from "@/components/prompt-editor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { AVAILABLE_MODELS } from "@/lib/role-meta";
import { useRouter } from "next/navigation";
import * as React from "react";
import type { VariantView } from "./variant-tabs";

export function PersonaTab({ variant }: { variant: VariantView }) {
  const router = useRouter();
  const { push } = useToast();
  const av = variant.activeVersion;
  const [systemPrompt, setSystemPrompt] = React.useState(av?.systemPrompt ?? "");
  const [model, setModel] = React.useState(av?.model ?? AVAILABLE_MODELS[0]);
  const [temperature, setTemperature] = React.useState(av?.temperature.toString() ?? "0.2");
  const [maxTokens, setMaxTokens] = React.useState(av?.maxTokens.toString() ?? "4096");
  const [notes, setNotes] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  async function savePersona() {
    setSaving(true);
    try {
      const res = await fetch("/api/prompt-versions/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          variantId: variant.id,
          systemPrompt,
          model,
          temperature: Number(temperature),
          maxTokens: Number(maxTokens),
          notes: notes || undefined,
          setActive: true,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "Kayıt hatası");
      }
      const data = await res.json();
      push({
        title: "Yeni sürüm yayımlandı",
        description: `v${data.version} aktif olarak atandı.`,
        variant: "success",
      });
      router.refresh();
    } catch (err) {
      push({
        title: "Kayıt başarısız",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <div className="flex flex-col gap-1.5">
          <Label>Model</Label>
          <Select value={model} onValueChange={setModel}>
            <SelectTrigger>
              <SelectValue placeholder="Model seçin" />
            </SelectTrigger>
            <SelectContent>
              {AVAILABLE_MODELS.map((m) => (
                <SelectItem key={m} value={m}>
                  {m}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>Sıcaklık (temperature)</Label>
          <Input
            type="number"
            step="0.05"
            min="0"
            max="2"
            value={temperature}
            onChange={(e) => setTemperature(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>Maks. Token</Label>
          <Input
            type="number"
            min="256"
            step="256"
            value={maxTokens}
            onChange={(e) => setMaxTokens(e.target.value)}
          />
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label>Sistem Prompt</Label>
        <PromptEditor value={systemPrompt} onChange={setSystemPrompt} />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label>Notlar (sürüm açıklaması)</Label>
        <Textarea
          placeholder="Bu sürümde ne değişti?"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </div>

      <div className="flex items-center justify-between border-t border-border pt-4">
        <div className="text-xs text-muted-foreground">
          {variant.versions.length > 0
            ? `Toplam ${variant.versions.length} sürüm · en son v${variant.versions[0].version}`
            : "Henüz sürüm yok"}
        </div>
        <Button onClick={savePersona} disabled={saving || !systemPrompt.trim()}>
          {saving ? "Kaydediliyor..." : "Yeni Sürüm Kaydet"}
        </Button>
      </div>

      {variant.versions.length > 0 && (
        <div className="rounded-md border border-border">
          <div className="border-b border-border bg-secondary/40 px-3 py-2 text-xs font-medium">
            Sürüm Geçmişi
          </div>
          <ul className="divide-y divide-border text-xs">
            {variant.versions.map((v) => (
              <li key={v.id} className="flex items-center justify-between px-3 py-2">
                <span className="font-mono">v{v.version}</span>
                <span className="text-muted-foreground">{v.model}</span>
                <span className="text-muted-foreground">
                  {new Date(v.createdAt).toLocaleDateString("tr-TR")}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
