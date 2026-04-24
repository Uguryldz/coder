"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { KnowledgeCategory } from "@orkestra/db";
import { KnowledgeTab } from "./knowledge-tab";
import { PersonaTab } from "./persona-tab";
import { TestTab } from "./test-tab";

export interface VariantView {
  id: string;
  name: string;
  role: string;
  activeVersion: {
    id: string;
    version: number;
    systemPrompt: string;
    model: string;
    temperature: number;
    maxTokens: number;
  } | null;
  versions: Array<{
    id: string;
    version: number;
    model: string;
    createdAt: string;
  }>;
  knowledgeFiles: Array<{
    id: string;
    filename: string;
    category: KnowledgeCategory;
    scope: "variant" | "shared";
    version: number;
  }>;
}

export interface SharedFile {
  id: string;
  filename: string;
  category: KnowledgeCategory;
}

export interface GoldenTicketLite {
  id: string;
  title: string;
  category: string | null;
}

export function VariantTabs({
  variant,
  sharedFiles,
  goldenTickets,
}: {
  variant: VariantView;
  sharedFiles: SharedFile[];
  goldenTickets: GoldenTicketLite[];
}) {
  return (
    <Tabs defaultValue="persona">
      <TabsList>
        <TabsTrigger value="persona">Persona</TabsTrigger>
        <TabsTrigger value="knowledge">Bilgi</TabsTrigger>
        <TabsTrigger value="test">Test</TabsTrigger>
      </TabsList>
      <TabsContent value="persona">
        <PersonaTab variant={variant} />
      </TabsContent>
      <TabsContent value="knowledge">
        <KnowledgeTab variant={variant} sharedFiles={sharedFiles} />
      </TabsContent>
      <TabsContent value="test">
        <TestTab variant={variant} goldenTickets={goldenTickets} />
      </TabsContent>
    </Tabs>
  );
}
