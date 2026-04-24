"use client";

import { KnowledgeTree, type KnowledgeNode } from "@/components/knowledge-tree";
import { MarkdownEditor } from "@/components/markdown-editor";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { KNOWLEDGE_CATEGORIES, KNOWLEDGE_CATEGORY_LABELS } from "@/lib/role-meta";
import { Plus, Save, Share2, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";
import type { SharedFile, VariantView } from "./variant-tabs";

type Cat = (typeof KNOWLEDGE_CATEGORIES)[number];

export function KnowledgeTab({
  variant,
  sharedFiles,
}: {
  variant: VariantView;
  sharedFiles: SharedFile[];
}) {
  const router = useRouter();
  const { push } = useToast();

  const nodes: KnowledgeNode[] = variant.knowledgeFiles.map((f) => ({
    id: f.id,
    filename: f.filename,
    category: f.category,
    scope: f.scope,
  }));

  const [selectedId, setSelectedId] = React.useState<string | null>(nodes[0]?.id ?? null);
  const [content, setContent] = React.useState<string>("");
  const [loading, setLoading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (!selectedId) {
      setContent("");
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetch(`/api/knowledge-content/${selectedId}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        setContent(d.content ?? "");
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  async function saveCurrent() {
    if (!selectedId) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/knowledge-content/${selectedId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) throw new Error("Kayıt hatası");
      push({
        title: "Bilgi dosyası kaydedildi",
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

  async function detach(id: string) {
    const ok = window.confirm("Bu dosyayı varyanttan kaldırmak istediğinize emin misiniz?");
    if (!ok) return;
    const res = await fetch("/api/knowledge/attach", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        variantId: variant.id,
        knowledgeFileId: id,
        detach: true,
      }),
    });
    if (res.ok) {
      if (selectedId === id) setSelectedId(null);
      push({ title: "Dosya bağlantısı kaldırıldı", variant: "success" });
      router.refresh();
    }
  }

  const selected = nodes.find((n) => n.id === selectedId) ?? null;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <AddFileDialog variantId={variant.id} />
          <AttachSharedDialog variantId={variant.id} sharedFiles={sharedFiles} />
        </div>
        <KnowledgeTree files={nodes} selectedId={selectedId} onSelect={setSelectedId} />
      </div>

      <div className="flex flex-col gap-3">
        {selected ? (
          <>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-medium">{selected.filename}</div>
                <div className="text-xs text-muted-foreground">
                  {KNOWLEDGE_CATEGORY_LABELS[selected.category]}
                  {selected.scope === "shared" && " · paylaşılan"}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => detach(selected.id)}>
                  <Trash2 className="h-3.5 w-3.5" />
                  Kaldır
                </Button>
                <Button
                  size="sm"
                  onClick={saveCurrent}
                  disabled={saving || selected.scope === "shared"}
                  title={
                    selected.scope === "shared"
                      ? "Paylaşılan dosyalar paylaşılan kütüphaneden düzenlenir"
                      : ""
                  }
                >
                  <Save className="h-3.5 w-3.5" />
                  {saving ? "Kaydediliyor..." : "Sürüm Kaydet"}
                </Button>
              </div>
            </div>
            {loading ? (
              <div className="rounded-md border border-border px-4 py-12 text-center text-sm text-muted-foreground">
                Yükleniyor...
              </div>
            ) : (
              <MarkdownEditor
                value={content}
                onChange={setContent}
                readOnly={selected.scope === "shared"}
                placeholder="Markdown içerik..."
              />
            )}
          </>
        ) : (
          <div className="flex h-full items-center justify-center rounded-md border border-dashed border-border px-4 py-20 text-sm text-muted-foreground">
            Düzenlemek için bir dosya seçin.
          </div>
        )}
      </div>
    </div>
  );
}

function AddFileDialog({ variantId }: { variantId: string }) {
  const router = useRouter();
  const { push } = useToast();
  const [open, setOpen] = React.useState(false);
  const [filename, setFilename] = React.useState("yeni-dosya.md");
  const [category, setCategory] = React.useState<Cat>("rules");
  const [busy, setBusy] = React.useState(false);

  async function create() {
    setBusy(true);
    try {
      const res = await fetch("/api/resources/knowledge-files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scope: "variant",
          ownerId: variantId,
          category,
          filename,
          contentKey: "",
          sizeBytes: 0,
          contentHash: "empty",
        }),
      });
      if (!res.ok) throw new Error("Oluşturulamadı");
      const created = (await res.json()) as { id: string };
      await fetch("/api/knowledge/attach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variantId, knowledgeFileId: created.id }),
      });
      push({ title: "Dosya eklendi", variant: "success" });
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
        <Button size="sm" variant="outline" className="gap-1">
          <Plus className="h-3.5 w-3.5" /> Dosya Ekle
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Yeni Bilgi Dosyası</DialogTitle>
          <DialogDescription>
            Bu varyanta özel yeni bir markdown dosyası oluşturun.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label>Dosya Adı</Label>
            <Input value={filename} onChange={(e) => setFilename(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Kategori</Label>
            <Select value={category} onValueChange={(v) => setCategory(v as Cat)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {KNOWLEDGE_CATEGORIES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {KNOWLEDGE_CATEGORY_LABELS[c]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            İptal
          </Button>
          <Button onClick={create} disabled={busy || !filename.trim()}>
            {busy ? "Oluşturuluyor..." : "Oluştur"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AttachSharedDialog({
  variantId,
  sharedFiles,
}: {
  variantId: string;
  sharedFiles: SharedFile[];
}) {
  const router = useRouter();
  const { push } = useToast();
  const [open, setOpen] = React.useState(false);
  const [pickId, setPickId] = React.useState<string>("");
  const [busy, setBusy] = React.useState(false);

  async function attach() {
    if (!pickId) return;
    setBusy(true);
    try {
      const res = await fetch("/api/knowledge/attach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variantId, knowledgeFileId: pickId }),
      });
      if (!res.ok) throw new Error("Eklenemedi");
      push({ title: "Paylaşılan dosya bağlandı", variant: "success" });
      setOpen(false);
      setPickId("");
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
        <Button size="sm" variant="outline" className="gap-1">
          <Share2 className="h-3.5 w-3.5" /> Paylaşılan Ekle
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Paylaşılan Dosya Bağla</DialogTitle>
          <DialogDescription>
            Mevcut paylaşılan kütüphaneden bir dosyayı bu varyanta bağlayın.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <Label>Dosya</Label>
          <Select value={pickId} onValueChange={setPickId}>
            <SelectTrigger>
              <SelectValue placeholder="Seçin..." />
            </SelectTrigger>
            <SelectContent>
              {sharedFiles.map((f) => (
                <SelectItem key={f.id} value={f.id}>
                  {f.filename} (
                  {KNOWLEDGE_CATEGORY_LABELS[f.category as keyof typeof KNOWLEDGE_CATEGORY_LABELS]})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            İptal
          </Button>
          <Button onClick={attach} disabled={busy || !pickId}>
            {busy ? "Bağlanıyor..." : "Bağla"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
