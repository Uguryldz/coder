import { useState } from "react";
import type { ReactNode } from "react";
import { WorkMode } from "@maestro/contracts";
import { messageKeyOf } from "../../api/errors.ts";
import { useT } from "../../i18n/I18nProvider.tsx";
import { Button, Modal, Select, useToast } from "../../ui/index.ts";
import { useEnumLabel } from "../common/label.ts";
import { useModeChange } from "../shared/signals.ts";

/**
 * "Değiştir" beside the mode badge: a link-button that opens a confirmation
 * with the new mode, then sends the `modeChange` signal — the same path
 * Jira's `/mode-change` comment takes.
 *
 * It confirms because changing mode mid-flow rewrites who does the work on a
 * ticket that may already carry human approvals. Offered only for a run the
 * engine is still executing; the caller decides that.
 */
export function ModeChange({
  ticket,
  current,
}: {
  readonly ticket: string;
  readonly current: WorkMode;
}): ReactNode {
  const t = useT();
  const toast = useToast();
  const enumLabel = useEnumLabel();
  const change = useModeChange();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<WorkMode>(current);

  function submit(): void {
    change.mutate(
      { ticket, mode },
      {
        onSuccess: (result) => {
          setOpen(false);
          toast.show(
            "success",
            t("detail.mode.changed", { ticket, mode: enumLabel("mode", result.mode).text }),
          );
        },
        onError: (error) => toast.show("error", t(messageKeyOf(error))),
      },
    );
  }

  return (
    <>
      <Button
        variant="link"
        size="sm"
        onClick={() => {
          setMode(current);
          setOpen(true);
        }}
      >
        {t("detail.mode.change")}
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={t("detail.mode.title", { ticket })}
        closeLabel={t("action.close")}
        footer={
          <>
            <Button onClick={() => setOpen(false)}>{t("action.cancel")}</Button>
            <Button
              variant="primary"
              busy={change.isPending}
              disabled={mode === current}
              onClick={submit}
            >
              {t("detail.mode.submit")}
            </Button>
          </>
        }
      >
        <Select
          label={t("detail.mode.field")}
          value={mode}
          onChange={(event) => setMode(event.target.value as WorkMode)}
          options={WorkMode.options.map((value) => ({
            value,
            label: enumLabel("mode", value).text,
          }))}
        />
        <p className="scr-hint">{t("detail.mode.body")}</p>
      </Modal>
    </>
  );
}
