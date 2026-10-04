import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type { ReactNode } from "react";
import { messageKeyOf } from "../api/errors.ts";
import { useApi, useAuth } from "../auth/AuthProvider.tsx";
import { hasAnyRole } from "../auth/types.ts";
import { useT } from "../i18n/I18nProvider.tsx";
import { Button, Card, Input, Select, TextArea, useToast } from "../ui/index.ts";
import { GuidanceList } from "./knowledge/GuidanceList.tsx";
import { GUIDANCE_QUERY_KEY, GUIDANCE_WRITE_ROLES, type GuidanceNote } from "./knowledge/types.ts";
import { fileToBase64 } from "./shared/file-base64.ts";
import type { AgentVariant } from "./Variants.tsx";

/**
 * Screen: knowledge — the "Öğrenme kaynakları" library.
 *
 * A note is a rule, a piece of institutional knowledge, or a "watch out for
 * this" instruction. The ENABLED notes are put in front of the analyst when a
 * new analysis is prepared (`packages/workflows/src/impl/guidance.ts`, read by
 * `writeAnalysis`), either for every agent or for one agent chosen here.
 *
 * Typed note and file upload land in the same table and go through the same
 * write path; toggling and deleting live in the shared `GuidanceList`.
 *
 * The old "Bilgi kütüphanesi — arama" section is gone: it searched a
 * `KnowledgeDoc` table nothing on this platform writes, and dropped every row
 * as confidential — a search box that could never find anything.
 */
export function KnowledgeScreen(): ReactNode {
  const t = useT();
  const api = useApi();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const canWrite = hasAnyRole(session, GUIDANCE_WRITE_ROLES);

  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  /** "" = every agent; otherwise the target agent's id. */
  const [target, setTarget] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  const notes = useQuery({
    queryKey: GUIDANCE_QUERY_KEY,
    queryFn: ({ signal }) => api.get<{ notes: readonly GuidanceNote[] }>("/studio/guidance", { signal }),
    retry: false,
  });

  // The agents a note may target. Read fails soft: with no list the note is
  // simply global, which is the default anyway.
  const agents = useQuery({
    queryKey: ["variants"],
    enabled: canWrite,
    retry: false,
    queryFn: ({ signal }) => api.get<{ variants: readonly AgentVariant[] }>("/variants", { signal }),
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: GUIDANCE_QUERY_KEY });
  };
  const variantId = target === "" ? null : target;

  const add = useMutation({
    mutationFn: (body: { title: string; content: string }) =>
      api.post<{ note: GuidanceNote }>("/studio/guidance", { ...body, enabled: true, variantId }),
    onSuccess: () => {
      setTitle("");
      setContent("");
      invalidate();
      toast.show("success", t("guidance.toast.added"));
    },
    onError: (error) => toast.show("error", t(messageKeyOf(error))),
  });

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const contentBase64 = await fileToBase64(file);
      return api.post<{ note: GuidanceNote }>("/studio/guidance/upload", {
        fileName: file.name,
        contentBase64,
        variantId,
      });
    },
    onSuccess: () => {
      invalidate();
      toast.show("success", t("guidance.toast.uploaded"));
    },
    onError: (error) => toast.show("error", t(messageKeyOf(error))),
  });

  const pickFile = (files: FileList | null): void => {
    const file = files?.[0];
    // Reset so choosing the same file again re-fires the change event.
    if (fileInput.current !== null) fileInput.current.value = "";
    if (file === undefined) return;
    upload.mutate(file);
  };

  const canSubmit = title.trim() !== "" && content.trim() !== "";
  const list = notes.data?.notes ?? [];

  return (
    <Card title={t("guidance.title")} subtitle={t("guidance.subtitle")}>
      <div className="scr-stack">
        {canWrite && (
          <div className="scr-stack">
            <div className="scr-grid scr-grid--2">
              <Input
                label={t("guidance.field.title")}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder={t("guidance.field.title_ph")}
              />
              <Select
                label={t("guidance.field.agent")}
                value={target}
                onChange={(event) => setTarget(event.target.value)}
                hint={t("guidance.field.agent_hint")}
                options={[
                  { value: "", label: t("guidance.scope.all") },
                  ...(agents.data?.variants ?? []).map((agent) => ({
                    value: agent.variantId,
                    label: `${agent.platform} · ${agent.variantId}`,
                  })),
                ]}
              />
            </div>
            <TextArea
              label={t("guidance.field.content")}
              rows={4}
              value={content}
              onChange={(event) => setContent(event.target.value)}
              placeholder={t("guidance.field.content_ph")}
              hint={t("guidance.field.content_hint")}
            />
            <div className="scr-row">
              <Button
                variant="primary"
                busy={add.isPending}
                disabled={!canSubmit}
                onClick={() => add.mutate({ title: title.trim(), content: content.trim() })}
              >
                {t("guidance.action.add")}
              </Button>
              <input
                ref={fileInput}
                type="file"
                accept=".md,.txt,.docx"
                hidden
                onChange={(event) => pickFile(event.target.files)}
                aria-hidden="true"
                tabIndex={-1}
              />
              <Button busy={upload.isPending} onClick={() => fileInput.current?.click()}>
                {t("guidance.action.upload")}
              </Button>
              <span className="scr-hint">{t("guidance.upload_hint")}</span>
            </div>
          </div>
        )}

        <GuidanceList
          notes={list}
          canWrite={canWrite}
          showScope
          isPending={notes.isPending}
          error={notes.error}
          emptyLabel={t("guidance.empty")}
          onRetry={() => void notes.refetch()}
        />
      </div>
    </Card>
  );
}
