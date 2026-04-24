"use client";

import { MarkdownEditor } from "@/components/markdown-editor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { useToast } from "@/components/ui/toast";
import { KNOWLEDGE_CATEGORIES, KNOWLEDGE_CATEGORY_LABELS } from "@/lib/role-meta";
import { Plus, Save, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";

type SharedFileRow = {
  id: string;
  filename: string;
  category: (typeof KNOWLEDGE_CATEGORIES)[number];
  version: number;
  usedBy: number;
};

export function SharedLibraryClient({ files }: { files: SharedFileRow[] }) {
  const router = useRouter();
  const { push } = useToast();
  const [selectedId, setSelectedId] = React.useState<string | null>(files[0]?.id ?? null);
  const [content, setContent] = React.useState("");
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
        if (!cancelled) setContent(d.content ?? "");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  async function save() {
    if (!selectedId) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/knowledge-content/${selectedId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) throw new Error("Kayıt hatası");
      push({ title: "Kaydedildi", variant: "success" });
      router.refresh();
    } catch (err) {
      push({
        title: "Hata",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    const ok = window.confirm("Bu paylaşılan dosya kalıcı olarak silinecek. Onaylıyor musunuz?");
    if (!ok) return;
    const res = await fetch(`/api/resources/knowledge-files/${id}`, {
      method: "DELETE",
    });
    if (res.ok) {
      push({ title: "Silindi", variant: "success" });
      if (selectedId === id) setSelectedId(null);
      router.refresh();
    }
  }

  const selected = files.find((f) => f.id === selectedId) ?? null;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
      <div className="flex flex-col gap-3">
        <CreateSharedFile />
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Dosyalar</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {files.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">Dosya yok.</p>
            ) : (
              <ul className="max-h-[600px] overflow-y-auto divide-y divide-border">
                {files.map((f) => (
                  <li
                    key={f.id}
                    onClick={() => setSelectedId(f.id)}
                    className={`cursor-pointer px-3 py-2 text-sm hover:bg-secondary/60 ${
                      selectedId === f.id ? "bg-primary/10" : ""
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="truncate">{f.filename}</span>
                      <Badge variant="outline" className="text-[10px]">
                        v{f.version}
                      </Badge>
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground">
                      <span>{KNOWLEDGE_CATEGORY_LABELS[f.category]}</span>
                      <span>·</span>
                      <span>{f.usedBy} varyant</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-col gap-3">
        {selected ? (
          <>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-medium">{selected.filename}</div>
                <div className="text-xs text-muted-foreground">
                  {KNOWLEDGE_CATEGORY_LABELS[selected.category]} · v{selected.version} ·{" "}
                  {selected.usedBy} varyant
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => remove(selected.id)}>
                  <Trash2 className="h-3.5 w-3.5" /> Sil
                </Button>
                <Button size="sm" onClick={save} disabled={saving}>
                  <Save className="h-3.5 w-3.5" />
                  {saving ? "Kaydediliyor..." : "Kaydet"}
                </Button>
              </div>
            </div>
            {loading ? (
              <div className="rounded-md border border-border px-4 py-12 text-center text-sm text-muted-foreground">
                Yükleniyor...
              </div>
            ) : (
              <MarkdownEditor value={content} onChange={setContent} />
            )}
          </>
        ) : (
          <div className="flex items-center justify-center rounded-md border border-dashed border-border px-4 py-20 text-sm text-muted-foreground">
            Düzenlemek için bir dosya seçin.
          </div>
        )}
      </div>
    </div>
  );
}

function CreateSharedFile() {
  const router = useRouter();
  const { push } = useToast();
  const [open, setOpen] = React.useState(false);
  const [filename, setFilename] = React.useState("yeni-dosya.md");
  const [category, setCategory] = React.useState<(typeof KNOWLEDGE_CATEGORIES)[number]>("rules");
  const [busy, setBusy] = React.useState(false);

  async function create() {
    setBusy(true);
    try {
      const res = await fetch("/api/resources/knowledge-files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scope: "shared",
          category,
          filename,
          contentKey: "",
          sizeBytes: 0,
          contentHash: "empty",
        }),
      });
      if (!res.ok) throw new Error("Oluşturulamadı");
      push({ title: "Dosya oluşturuldu", variant: "success" });
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
        <Button size="sm" variant="outline" className="gap-1 self-start">
          <Plus className="h-3.5 w-3.5" /> Yeni Paylaşılan Dosya
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Paylaşılan Dosya</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label>Dosya Adı</Label>
            <Input value={filename} onChange={(e) => setFilename(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Kategori</Label>
            <Select
              value={category}
              onValueChange={(v) => setCategory(v as (typeof KNOWLEDGE_CATEGORIES)[number])}
            >
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
