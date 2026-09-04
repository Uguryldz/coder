import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ReactNode } from "react";
import { messageKeyOf } from "../../api/errors.ts";
import { useApi } from "../../auth/AuthProvider.tsx";
import { useT } from "../../i18n/I18nProvider.tsx";
import { Badge, Button, Modal, Table, useToast } from "../../ui/index.ts";
import { QueryState } from "../shared/QueryState.tsx";
import { GUIDANCE_QUERY_KEY, excerpt, targetOf, type GuidanceNote } from "./types.ts";

/**
 * The guidance-note table both screens draw — the library (every note) and an
 * agent's detail (only its own). One component so the two never disagree on
 * what a toggle or a delete does:
 *
 *  · a toggle reports what it did ("etkin" / "kapalı") — a silent flip left the
 *    operator unsure whether the click registered;
 *  · a delete asks first, naming the note; no reason field, because the BFF
 *    stores none and asking for one it throws away would be a lie;
 *  · a failure shows the SERVER's reason (translated), never a fixed
 *    "İşlem başarısız.".
 */
export function GuidanceList({
  notes,
  canWrite,
  showScope,
  isPending,
  error,
  emptyLabel,
  onRetry,
}: {
  readonly notes: readonly GuidanceNote[];
  readonly canWrite: boolean;
  /** Show which agent a note targets — the library does, an agent's own tab need not. */
  readonly showScope: boolean;
  readonly isPending: boolean;
  readonly error: unknown;
  readonly emptyLabel: string;
  readonly onRetry: () => void;
}): ReactNode {
  const t = useT();
  const api = useApi();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [removing, setRemoving] = useState<GuidanceNote | null>(null);

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: GUIDANCE_QUERY_KEY });
  };

  const toggle = useMutation({
    mutationFn: (note: GuidanceNote) =>
      api.put<{ note: GuidanceNote }>(`/studio/guidance/${note.id}`, { enabled: !note.enabled }),
    onSuccess: (result) => {
      invalidate();
      toast.show("success", t(result.note.enabled ? "guidance.toast.enabled" : "guidance.toast.disabled"));
    },
    onError: (err) => toast.show("error", t(messageKeyOf(err))),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete<void>(`/studio/guidance/${id}`),
    onSuccess: () => {
      setRemoving(null);
      invalidate();
      toast.show("success", t("guidance.toast.removed"));
    },
    onError: (err) => toast.show("error", t(messageKeyOf(err))),
  });

  const status = (note: GuidanceNote): ReactNode => (
    <Badge tone={note.enabled ? "green" : "gray"}>
      {note.enabled ? t("guidance.learn.on") : t("guidance.learn.off")}
    </Badge>
  );

  return (
    <>
      <QueryState
        isPending={isPending}
        error={error}
        isEmpty={notes.length === 0}
        emptyTitle={emptyLabel}
        onRetry={onRetry}
      >
        <Table
          columns={[
            {
              key: "title",
              header: t("guidance.col.title"),
              cell: (note: GuidanceNote) => (
                <span className="scr-row">
                  {note.title}
                  {showScope && (
                    <Badge tone={targetOf(note) === "" ? "gray" : "blue"}>
                      {targetOf(note) === ""
                        ? t("guidance.scope.all")
                        : t("guidance.scope.variant", { id: targetOf(note) })}
                    </Badge>
                  )}
                </span>
              ),
            },
            {
              key: "content",
              header: t("guidance.col.content"),
              cell: (note) => (
                <span className="scr-hint" title={note.content}>
                  {excerpt(note.content)}
                </span>
              ),
            },
            {
              key: "enabled",
              header: t("guidance.col.learn"),
              cell: (note) =>
                canWrite ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => toggle.mutate(note)}
                    disabled={toggle.isPending}
                    aria-label={t(note.enabled ? "guidance.action.disable" : "guidance.action.enable", {
                      title: note.title,
                    })}
                  >
                    {status(note)}
                  </Button>
                ) : (
                  status(note)
                ),
            },
            ...(canWrite
              ? [
                  {
                    key: "actions",
                    header: "",
                    cell: (note: GuidanceNote) => (
                      <Button size="sm" onClick={() => setRemoving(note)}>
                        {t("guidance.action.remove")}
                      </Button>
                    ),
                  },
                ]
              : []),
          ]}
          rows={notes}
          rowKey={(note) => note.id}
          emptyLabel={emptyLabel}
        />
      </QueryState>

      {removing !== null && (
        <Modal
          open
          onClose={() => setRemoving(null)}
          title={t("guidance.confirm.remove_title")}
          closeLabel={t("action.close")}
          footer={
            <>
              <Button onClick={() => setRemoving(null)}>{t("action.cancel")}</Button>
              <Button variant="danger" busy={remove.isPending} onClick={() => remove.mutate(removing.id)}>
                {t("guidance.action.remove")}
              </Button>
            </>
          }
        >
          <p className="scr-prose">{t("guidance.confirm.remove", { title: removing.title })}</p>
        </Modal>
      )}
    </>
  );
}
