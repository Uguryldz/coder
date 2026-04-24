"use client";

import dynamic from "next/dynamic";

const Monaco = dynamic(() => import("@monaco-editor/react"), { ssr: false });

export interface PromptEditorProps {
  value: string;
  onChange: (value: string) => void;
  language?: string;
  readOnly?: boolean;
  height?: string | number;
}

export function PromptEditor({
  value,
  onChange,
  language = "markdown",
  readOnly = false,
  height = 460,
}: PromptEditorProps) {
  return (
    <div className="overflow-hidden rounded-md border border-border">
      <Monaco
        value={value}
        language={language}
        height={height}
        theme="vs-light"
        options={{
          readOnly,
          minimap: { enabled: false },
          fontSize: 13,
          wordWrap: "on",
          lineNumbers: "on",
          scrollBeyondLastLine: false,
          automaticLayout: true,
          tabSize: 2,
        }}
        onChange={(v) => onChange(v ?? "")}
      />
    </div>
  );
}
