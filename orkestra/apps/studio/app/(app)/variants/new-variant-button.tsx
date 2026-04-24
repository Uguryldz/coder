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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { AGENT_ROLES, ROLE_LABELS, type AgentRole } from "@/lib/role-meta";
import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";

export function NewVariantButton() {
  const router = useRouter();
  const { push } = useToast();
  const [open, setOpen] = React.useState(false);
  const [role, setRole] = React.useState<AgentRole>("analyst");
  const [name, setName] = React.useState("");
  const [displayName, setDisplayName] = React.useState("");
  const [cloneFrom, setCloneFrom] = React.useState<string>("");
  const [description, setDescription] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [existing, setExisting] = React.useState<Array<{ id: string; role: string; name: string }>>([]);

  React.useEffect(() => {
    fetch("/api/resources/agentVariant?_start=0&_end=100")
      .then((r) => r.json())
      .then((rows) => setExisting(Array.isArray(rows) ? rows : []))
      .catch(() => {});
  }, [open]);

  async function submit() {
    if (!name.trim()) {
      push({ title: "Variant adı zorunlu", variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/variants/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          role,
          name: name.trim(),
          displayName: displayName.trim() || name.trim(),
          description: description.trim() || null,
          cloneFromVariantId: cloneFrom || null,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      const { id } = await res.json();
      push({ title: "Variant oluşturuldu", description: `${role}/${name}` });
      setOpen(false);
      router.push(`/variants/${id}`);
      router.refresh();
    } catch (e) {
      push({
        title: "Hata",
        description: (e as Error).message,
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  }

  const sameRoleExisting = existing.filter((v) => v.role === role);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="mr-1 h-4 w-4" /> Yeni Variant
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Yeni Ajan Variant'ı</DialogTitle>
          <DialogDescription>
            Bir rolün domain-specific versiyonu (örn. <code>mobile-analyst</code>).
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label>Rol</Label>
            <Select value={role} onValueChange={(v) => setRole(v as AgentRole)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AGENT_ROLES.map((r) => (
                  <SelectItem key={r} value={r}>
                    {ROLE_LABELS[r]} ({r})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Variant adı</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))}
              placeholder="örn. mobile-analyst"
            />
            <p className="text-xs text-muted-foreground">
              Benzersiz, küçük harfli, kebab-case. Rutin: <code>{role}/mobile</code>, <code>{role}/web</code>, vb.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Görünen ad (opsiyonel)</Label>
            <Input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder={name || "Mobile Analyst"}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Açıklama (opsiyonel)</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Bu variant neyi yapıyor?"
              rows={2}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Baz al (opsiyonel)</Label>
            <Select value={cloneFrom || "none"} onValueChange={(v) => setCloneFrom(v === "none" ? "" : v)}>
              <SelectTrigger>
                <SelectValue placeholder="Boş bırak → varsayılan prompt" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">(Sıfırdan, varsayılan prompt)</SelectItem>
                {sameRoleExisting.map((v) => (
                  <SelectItem key={v.id} value={v.id}>
                    {v.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Mevcut bir variant'ın persona + knowledge'ını kopyalar.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
            İptal
          </Button>
          <Button onClick={submit} disabled={busy || !name.trim()}>
            {busy ? "Oluşturuluyor..." : "Oluştur"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
