"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { WORK_MODE_LABELS } from "@/lib/role-meta";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";

type Rule = {
  id: string;
  name: string;
  priority: number;
  matchLabel: string | null;
  matchComponent: string | null;
  matchProject: string | null;
  matchWorkType: string | null;
  workMode: string;
  active: boolean;
  variantId: string;
  variantName: string;
  variantRole: string;
};

type VariantOption = { id: string; label: string };

const WORK_MODES = ["full_auto", "ai_assist", "human_lead", "human_only"] as const;

export function RoutingRulesClient({
  rules,
  variants,
}: {
  rules: Rule[];
  variants: VariantOption[];
}) {
  const router = useRouter();
  const { push } = useToast();

  async function remove(id: string) {
    if (!window.confirm("Kural silinsin mi?")) return;
    const res = await fetch(`/api/resources/routing-rules/${id}`, {
      method: "DELETE",
    });
    if (res.ok) {
      push({ title: "Silindi", variant: "success" });
      router.refresh();
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        <RuleDialog variants={variants} />
      </div>

      <div className="rounded-md border border-border bg-card">
        {rules.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted-foreground">
            Kural yok. Yeni kural ekleyin.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Öncelik</TableHead>
                <TableHead>Ad</TableHead>
                <TableHead>Eşleşme</TableHead>
                <TableHead>Varyant</TableHead>
                <TableHead>Mod</TableHead>
                <TableHead>Durum</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rules.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono text-xs">{r.priority}</TableCell>
                  <TableCell className="text-sm font-medium">{r.name}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    <MatchSummary rule={r} />
                  </TableCell>
                  <TableCell className="text-xs">
                    <div>{r.variantName}</div>
                    <div className="text-muted-foreground">{r.variantRole}</div>
                  </TableCell>
                  <TableCell className="text-xs">
                    {WORK_MODE_LABELS[r.workMode] ?? r.workMode}
                  </TableCell>
                  <TableCell>
                    {r.active ? (
                      <Badge variant="success" className="text-[10px]">
                        aktif
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="text-[10px]">
                        pasif
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <RuleDialog variants={variants} existing={r} />
                      <Button variant="ghost" size="icon" onClick={() => remove(r.id)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}

function MatchSummary({ rule }: { rule: Rule }) {
  const parts: string[] = [];
  if (rule.matchLabel) parts.push(`label=${rule.matchLabel}`);
  if (rule.matchComponent) parts.push(`component=${rule.matchComponent}`);
  if (rule.matchProject) parts.push(`project=${rule.matchProject}`);
  if (rule.matchWorkType) parts.push(`type=${rule.matchWorkType}`);
  return <>{parts.length > 0 ? parts.join(", ") : "— her şey —"}</>;
}

function RuleDialog({ variants, existing }: { variants: VariantOption[]; existing?: Rule }) {
  const router = useRouter();
  const { push } = useToast();
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState(existing?.name ?? "");
  const [priority, setPriority] = React.useState(String(existing?.priority ?? 100));
  const [variantId, setVariantId] = React.useState(existing?.variantId ?? "");
  const [workMode, setWorkMode] = React.useState(existing?.workMode ?? "full_auto");
  const [matchLabel, setMatchLabel] = React.useState(existing?.matchLabel ?? "");
  const [matchComponent, setMatchComponent] = React.useState(existing?.matchComponent ?? "");
  const [matchProject, setMatchProject] = React.useState(existing?.matchProject ?? "");
  const [matchWorkType, setMatchWorkType] = React.useState(existing?.matchWorkType ?? "");
  const [active, setActive] = React.useState(existing?.active ?? true);
  const [busy, setBusy] = React.useState(false);

  async function submit() {
    setBusy(true);
    try {
      const body = {
        name,
        priority: Number(priority),
        variantId,
        workMode,
        matchLabel: matchLabel || null,
        matchComponent: matchComponent || null,
        matchProject: matchProject || null,
        matchWorkType: matchWorkType || null,
        active,
      };
      const res = existing
        ? await fetch(`/api/resources/routing-rules/${existing.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          })
        : await fetch("/api/resources/routing-rules", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
      if (!res.ok) throw new Error("Kayıt hatası");
      push({ title: existing ? "Güncellendi" : "Oluşturuldu", variant: "success" });
      setOpen(false);
      router.refresh();
    } catch (err) {
      push({
        title: "Hata",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {existing ? (
          <Button variant="ghost" size="icon">
            <Pencil className="h-3.5 w-3.5" />
          </Button>
        ) : (
          <Button className="gap-1">
            <Plus className="h-3.5 w-3.5" /> Yeni Kural
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{existing ? "Kural Düzenle" : "Yeni Yönlendirme Kuralı"}</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label="Ad">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Öncelik (küçük=önce)">
            <Input type="number" value={priority} onChange={(e) => setPriority(e.target.value)} />
          </Field>
          <Field label="Varyant" className="md:col-span-2">
            <Select value={variantId} onValueChange={setVariantId}>
              <SelectTrigger>
                <SelectValue placeholder="Seçin..." />
              </SelectTrigger>
              <SelectContent>
                {variants.map((v) => (
                  <SelectItem key={v.id} value={v.id}>
                    {v.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="İş Modu">
            <Select value={workMode} onValueChange={setWorkMode}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WORK_MODES.map((m) => (
                  <SelectItem key={m} value={m}>
                    {WORK_MODE_LABELS[m]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Aktif">
            <label className="flex h-9 items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={active}
                onChange={(e) => setActive(e.target.checked)}
              />
              etkin
            </label>
          </Field>
          <Field label="Etiket eşleşme">
            <Input value={matchLabel} onChange={(e) => setMatchLabel(e.target.value)} />
          </Field>
          <Field label="Bileşen eşleşme">
            <Input value={matchComponent} onChange={(e) => setMatchComponent(e.target.value)} />
          </Field>
          <Field label="Proje eşleşme">
            <Input value={matchProject} onChange={(e) => setMatchProject(e.target.value)} />
          </Field>
          <Field label="İş tipi eşleşme">
            <Input value={matchWorkType} onChange={(e) => setMatchWorkType(e.target.value)} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            İptal
          </Button>
          <Button onClick={submit} disabled={busy || !name.trim() || !variantId}>
            {busy ? "Kaydediliyor..." : "Kaydet"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  children,
  className = "",
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      <Label>{label}</Label>
      {children}
    </div>
  );
}
