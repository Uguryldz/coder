"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  Bold,
  Code2,
  Heading2,
  Heading3,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Quote,
} from "lucide-react";
import * as React from "react";
import TurndownService from "turndown";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});

function mdToHtml(md: string): string {
  // Very lightweight markdown->HTML for initial display. Server-authored
  // markdown passes through; Tiptap renders it and we only export markdown
  // back on save via turndown.
  const escaped = md.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<pre>${escaped}</pre>`;
}

export interface MarkdownEditorProps {
  value: string;
  onChange: (markdown: string) => void;
  placeholder?: string;
  className?: string;
  readOnly?: boolean;
}

export function MarkdownEditor({
  value,
  onChange,
  placeholder = "İçerik yazın...",
  className,
  readOnly = false,
}: MarkdownEditorProps) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ codeBlock: { HTMLAttributes: { class: "rounded" } } }),
      Placeholder.configure({ placeholder }),
      Link.configure({ openOnClick: false, autolink: true }),
    ],
    content: value ? mdToHtml(value) : "",
    editable: !readOnly,
    immediatelyRender: false,
    onUpdate: ({ editor }) => {
      const html = editor.getHTML();
      const md = turndown.turndown(html);
      onChange(md);
    },
  });

  // Sync external value updates (e.g. switching files).
  React.useEffect(() => {
    if (!editor) return;
    const currentMd = turndown.turndown(editor.getHTML());
    if (currentMd !== value) {
      editor.commands.setContent(value ? mdToHtml(value) : "", false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, editor]);

  if (!editor) return null;

  return (
    <div className={cn("rounded-md border border-border bg-background", className)}>
      {!readOnly && (
        <div className="flex flex-wrap items-center gap-1 border-b border-border bg-secondary/40 px-2 py-1">
          <ToolbarButton
            active={editor.isActive("bold")}
            onClick={() => editor.chain().focus().toggleBold().run()}
            icon={<Bold className="h-3.5 w-3.5" />}
            label="Kalın"
          />
          <ToolbarButton
            active={editor.isActive("italic")}
            onClick={() => editor.chain().focus().toggleItalic().run()}
            icon={<Italic className="h-3.5 w-3.5" />}
            label="İtalik"
          />
          <div className="mx-1 h-4 w-px bg-border" />
          <ToolbarButton
            active={editor.isActive("heading", { level: 2 })}
            onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
            icon={<Heading2 className="h-3.5 w-3.5" />}
            label="Başlık 2"
          />
          <ToolbarButton
            active={editor.isActive("heading", { level: 3 })}
            onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
            icon={<Heading3 className="h-3.5 w-3.5" />}
            label="Başlık 3"
          />
          <div className="mx-1 h-4 w-px bg-border" />
          <ToolbarButton
            active={editor.isActive("bulletList")}
            onClick={() => editor.chain().focus().toggleBulletList().run()}
            icon={<List className="h-3.5 w-3.5" />}
            label="Madde"
          />
          <ToolbarButton
            active={editor.isActive("orderedList")}
            onClick={() => editor.chain().focus().toggleOrderedList().run()}
            icon={<ListOrdered className="h-3.5 w-3.5" />}
            label="Numaralı"
          />
          <ToolbarButton
            active={editor.isActive("blockquote")}
            onClick={() => editor.chain().focus().toggleBlockquote().run()}
            icon={<Quote className="h-3.5 w-3.5" />}
            label="Alıntı"
          />
          <ToolbarButton
            active={editor.isActive("codeBlock")}
            onClick={() => editor.chain().focus().toggleCodeBlock().run()}
            icon={<Code2 className="h-3.5 w-3.5" />}
            label="Kod"
          />
          <ToolbarButton
            active={editor.isActive("link")}
            onClick={() => {
              const url = window.prompt("Bağlantı URL'si");
              if (!url) return;
              editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
            }}
            icon={<LinkIcon className="h-3.5 w-3.5" />}
            label="Bağlantı"
          />
        </div>
      )}
      <EditorContent editor={editor} />
    </div>
  );
}

function ToolbarButton({
  icon,
  label,
  onClick,
  active,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <Button
      variant={active ? "secondary" : "ghost"}
      size="icon"
      className="h-7 w-7"
      onClick={onClick}
      title={label}
      type="button"
    >
      {icon}
    </Button>
  );
}
