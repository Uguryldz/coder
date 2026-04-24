"use client";

import { Badge } from "@/components/ui/badge";
import { KNOWLEDGE_CATEGORIES, KNOWLEDGE_CATEGORY_LABELS } from "@/lib/role-meta";
import { cn } from "@/lib/utils";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronDown, ChevronRight, FileText, GripVertical, Share2 } from "lucide-react";
import * as React from "react";

export interface KnowledgeNode {
  id: string;
  filename: string;
  category: (typeof KNOWLEDGE_CATEGORIES)[number];
  scope: "variant" | "shared";
}

export interface KnowledgeTreeProps {
  files: KnowledgeNode[];
  selectedId?: string | null;
  onSelect: (id: string) => void;
  onReorder?: (category: string, newOrder: string[]) => void;
}

export function KnowledgeTree({ files, selectedId, onSelect, onReorder }: KnowledgeTreeProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const [expanded, setExpanded] = React.useState<Record<string, boolean>>(() =>
    Object.fromEntries(KNOWLEDGE_CATEGORIES.map((c) => [c, true])),
  );

  const grouped = React.useMemo(() => {
    const acc: Record<string, KnowledgeNode[]> = {};
    for (const cat of KNOWLEDGE_CATEGORIES) acc[cat] = [];
    for (const f of files) {
      (acc[f.category] ??= []).push(f);
    }
    return acc;
  }, [files]);

  const toggle = (cat: string) => setExpanded((s) => ({ ...s, [cat]: !s[cat] }));

  return (
    <div className="flex flex-col gap-2 text-sm">
      {KNOWLEDGE_CATEGORIES.map((cat) => {
        const items = grouped[cat] ?? [];
        const isOpen = expanded[cat] ?? true;
        return (
          <div key={cat} className="rounded-md border border-border bg-card">
            <button
              type="button"
              onClick={() => toggle(cat)}
              className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-secondary/60"
            >
              <span className="flex items-center gap-2 font-medium">
                {isOpen ? (
                  <ChevronDown className="h-3.5 w-3.5" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5" />
                )}
                {KNOWLEDGE_CATEGORY_LABELS[cat]}
              </span>
              <span className="text-xs text-muted-foreground">{items.length}</span>
            </button>
            {isOpen && (
              <div className="border-t border-border px-1 py-1">
                {items.length === 0 ? (
                  <p className="px-3 py-2 text-xs text-muted-foreground">Dosya yok</p>
                ) : (
                  <DndContext
                    sensors={sensors}
                    collisionDetection={closestCenter}
                    onDragEnd={(event: DragEndEvent) => {
                      const { active, over } = event;
                      if (!over || active.id === over.id || !onReorder) return;
                      const oldIdx = items.findIndex((i) => i.id === active.id);
                      const newIdx = items.findIndex((i) => i.id === over.id);
                      const next = arrayMove(items, oldIdx, newIdx).map((i) => i.id);
                      onReorder(cat, next);
                    }}
                  >
                    <SortableContext
                      items={items.map((i) => i.id)}
                      strategy={verticalListSortingStrategy}
                    >
                      <ul className="flex flex-col gap-0.5">
                        {items.map((f) => (
                          <SortableItem
                            key={f.id}
                            node={f}
                            active={selectedId === f.id}
                            onSelect={() => onSelect(f.id)}
                          />
                        ))}
                      </ul>
                    </SortableContext>
                  </DndContext>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function SortableItem({
  node,
  active,
  onSelect,
}: {
  node: KnowledgeNode;
  active: boolean;
  onSelect: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: node.id,
  });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };
  return (
    <li
      ref={setNodeRef}
      style={style}
      className={cn(
        "flex items-center gap-2 rounded px-2 py-1.5 text-xs cursor-pointer hover:bg-secondary/60",
        active && "bg-primary/10 text-primary",
      )}
      onClick={onSelect}
    >
      <span
        className="cursor-grab text-muted-foreground hover:text-foreground"
        {...attributes}
        {...listeners}
        onClick={(e) => e.stopPropagation()}
      >
        <GripVertical className="h-3 w-3" />
      </span>
      <FileText className="h-3.5 w-3.5 text-muted-foreground" />
      <span className="flex-1 truncate">{node.filename}</span>
      {node.scope === "shared" && (
        <Badge variant="secondary" className="h-5 gap-1 px-1.5 py-0 text-[10px]">
          <Share2 className="h-2.5 w-2.5" /> paylaşılan
        </Badge>
      )}
    </li>
  );
}
